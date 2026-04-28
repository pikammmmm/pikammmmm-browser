import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ChromeImportResult, ChromeProfileInfo } from '@shared/types.js';
import type { PasswordService } from './passwords.js';
import type { BookmarksService } from './bookmarks.js';

const execFileP = promisify(execFile);

function chromeUserDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'Google', 'Chrome', 'User Data');
}

/** Returns absolute paths to every profile dir (Default + Profile 1..N). */
function chromeProfileDirs(): string[] {
  const root = chromeUserDataDir();
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'Default' || /^Profile \d+$/.test(entry)) {
      out.push(join(root, entry));
    }
  }
  return out;
}

function localStatePath(): string {
  return join(chromeUserDataDir(), 'Local State');
}

interface LocalStateProfileEntry {
  name?: string;
  gaia_name?: string;
  gaia_given_name?: string;
}

interface LocalStateShape {
  profile?: { info_cache?: Record<string, LocalStateProfileEntry> };
  os_crypt?: { encrypted_key?: string };
}

function readLocalState(): LocalStateShape | null {
  if (!existsSync(localStatePath())) return null;
  try {
    return JSON.parse(readFileSync(localStatePath(), 'utf8')) as LocalStateShape;
  } catch {
    return null;
  }
}

export function listChromeProfiles(): ChromeProfileInfo[] {
  const dirs = chromeProfileDirs();
  const ls = readLocalState();
  const cache = ls?.profile?.info_cache ?? {};
  return dirs.map((dir) => {
    const dirName = dir.split(/[\\/]/).pop() ?? '';
    const entry = cache[dirName];
    const account = (entry?.gaia_name?.trim() || entry?.gaia_given_name?.trim()) ?? null;
    return {
      dir,
      dirName,
      name: entry?.name ?? dirName,
      account: account || null,
    };
  });
}

/**
 * Decrypt bytes that Windows DPAPI protected (CurrentUser scope).
 * We shell out to PowerShell to avoid a native dependency.
 */
async function dpapiUnprotect(bytes: Buffer): Promise<Buffer> {
  const b64 = bytes.toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
  `.trim();
  const { stdout } = await execFileP('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    ps,
  ]);
  return Buffer.from(stdout.trim(), 'base64');
}

export async function getChromeMasterKey(): Promise<Buffer> {
  if (!existsSync(localStatePath())) {
    throw new Error('Chrome not detected (no Local State file).');
  }
  const raw = readFileSync(localStatePath(), 'utf8');
  const json = JSON.parse(raw) as { os_crypt?: { encrypted_key?: string } };
  const b64 = json.os_crypt?.encrypted_key;
  if (!b64) throw new Error('Chrome Local State has no encrypted key.');
  const enc = Buffer.from(b64, 'base64');
  // strip 5-byte "DPAPI" prefix
  const stripped = enc.subarray(5);
  return dpapiUnprotect(stripped);
}

function decryptChromePassword(encrypted: Buffer, key: Buffer): string | null {
  if (encrypted.length < 3) return null;
  const prefix = encrypted.subarray(0, 3).toString('utf8');
  if (prefix === 'v10' || prefix === 'v11') {
    const iv = encrypted.subarray(3, 15);
    const ciphertext = encrypted.subarray(15, encrypted.length - 16);
    const tag = encrypted.subarray(encrypted.length - 16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
  // Older DPAPI-only format would need a per-row PowerShell call; skip in v1.
  return null;
}

export async function importChromePasswords(
  passwords: PasswordService,
  profileDir?: string | null,
): Promise<ChromeImportResult> {
  const allProfiles = chromeProfileDirs();
  if (allProfiles.length === 0) {
    throw new Error('Chrome User Data folder not found.');
  }
  const profiles = profileDir ? allProfiles.filter((p) => p === profileDir) : allProfiles;
  if (profiles.length === 0) {
    throw new Error('Selected Chrome profile not found.');
  }
  const key = await getChromeMasterKey();
  let imported = 0;
  let skipped = 0;
  for (const profile of profiles) {
    const src = join(profile, 'Login Data');
    if (!existsSync(src)) continue;
    const tmpDb = join(tmpdir(), `cb-chrome-login-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      copyFileSync(src, tmpDb);
    } catch {
      continue;
    }
    const db = new Database(tmpDb, { readonly: true });
    try {
      const rows = db
        .prepare(
          `SELECT origin_url AS url, username_value AS username, password_value AS pw
           FROM logins
           WHERE blacklisted_by_user = 0`,
        )
        .all() as Array<{ url: string; username: string; pw: Buffer }>;
      for (const row of rows) {
        if (!row.url || !row.username || !row.pw || row.pw.length === 0) {
          skipped++;
          continue;
        }
        const password = decryptChromePassword(row.pw, key);
        if (!password) {
          skipped++;
          continue;
        }
        let origin: string;
        try {
          origin = new URL(row.url).origin;
        } catch {
          skipped++;
          continue;
        }
        try {
          passwords.save(origin, row.username, password);
          imported++;
        } catch {
          skipped++;
        }
      }
    } finally {
      db.close();
    }
  }
  return { imported, skipped };
}

interface ChromeBookmarkNode {
  type?: 'url' | 'folder';
  name?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

/** Tiny CSV parser handling double-quoted fields with embedded commas + escaped quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Import passwords from a Chrome-exported CSV. The user gets the file from
 * chrome://password-manager/settings → Export passwords. Header is:
 * name,url,username,password,note  (note is sometimes absent on older Chrome).
 */
export function importPasswordsCsv(
  svc: PasswordService,
  csvPath: string,
): ChromeImportResult {
  const text = readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) return { imported: 0, skipped: 0 };
  const header = rows[0]!.map((h) => h.toLowerCase().trim());
  const urlIdx = header.indexOf('url');
  const userIdx = header.indexOf('username');
  const pwIdx = header.indexOf('password');
  if (urlIdx < 0 || userIdx < 0 || pwIdx < 0) {
    throw new Error('CSV header must contain url, username, password columns.');
  }
  let imported = 0;
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const url = row[urlIdx];
    const username = row[userIdx];
    const password = row[pwIdx];
    if (!url || !username || !password) {
      skipped++;
      continue;
    }
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      skipped++;
      continue;
    }
    try {
      svc.save(origin, username, password);
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}

export function importChromeBookmarks(
  svc: BookmarksService,
  profileDir?: string | null,
): ChromeImportResult {
  const allProfiles = chromeProfileDirs();
  if (allProfiles.length === 0) {
    throw new Error('Chrome User Data folder not found.');
  }
  const profiles = profileDir ? allProfiles.filter((p) => p === profileDir) : allProfiles;
  if (profiles.length === 0) {
    throw new Error('Selected Chrome profile not found.');
  }
  const profilesByName = new Map(listChromeProfiles().map((p) => [p.dir, p.name]));
  let imported = 0;
  let skipped = 0;
  let foundFile = false;
  for (const profile of profiles) {
    const path = join(profile, 'Bookmarks');
    if (!existsSync(path)) continue;
    foundFile = true;
    const profileName = profilesByName.get(profile) ?? profile.split(/[\\/]/).pop() ?? '';
    let json: { roots?: Record<string, ChromeBookmarkNode> };
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    const walk = (node: ChromeBookmarkNode, folder: string, inBar: boolean): void => {
      if (node.type === 'url' && typeof node.url === 'string') {
        try {
          svc.add({
            url: node.url,
            title: node.name ?? '',
            folder: folder || null,
            inBar,
          });
          imported++;
        } catch {
          skipped++;
        }
      } else if (node.type === 'folder' && Array.isArray(node.children)) {
        const sub = folder ? `${folder}/${node.name ?? ''}` : node.name ?? '';
        for (const child of node.children) walk(child, sub, inBar);
      }
    };
    const roots = json.roots ?? {};
    for (const rootKey of ['bookmark_bar', 'other', 'synced']) {
      const root = roots[rootKey];
      if (!root) continue;
      const rootName = root.name ?? rootKey;
      const topFolder = `${profileName}/${rootName}`;
      const inBar = rootKey === 'bookmark_bar';
      if (Array.isArray(root.children)) {
        for (const child of root.children) walk(child, topFolder, inBar);
      }
    }
  }
  if (!foundFile) throw new Error('No Bookmarks file found in any Chrome profile.');
  return { imported, skipped };
}
