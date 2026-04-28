import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ChromeImportResult } from '@shared/types.js';
import type { PasswordService } from './passwords.js';
import type { BookmarksService } from './bookmarks.js';

const execFileP = promisify(execFile);

function chromeUserDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'Google', 'Chrome', 'User Data');
}

function defaultProfilePath(...rest: string[]): string {
  return join(chromeUserDataDir(), 'Default', ...rest);
}

function localStatePath(): string {
  return join(chromeUserDataDir(), 'Local State');
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
): Promise<ChromeImportResult> {
  const src = defaultProfilePath('Login Data');
  if (!existsSync(src)) {
    throw new Error('Chrome login DB not found at expected path.');
  }
  const key = await getChromeMasterKey();

  const tmpDb = join(tmpdir(), `cb-chrome-login-data-${Date.now()}.db`);
  copyFileSync(src, tmpDb);

  let imported = 0;
  let skipped = 0;
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
  return { imported, skipped };
}

interface ChromeBookmarkNode {
  type?: 'url' | 'folder';
  name?: string;
  url?: string;
  children?: ChromeBookmarkNode[];
}

export function importChromeBookmarks(svc: BookmarksService): ChromeImportResult {
  const path = defaultProfilePath('Bookmarks');
  if (!existsSync(path)) {
    throw new Error('Chrome bookmarks file not found.');
  }
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    roots?: Record<string, ChromeBookmarkNode>;
  };
  let imported = 0;
  let skipped = 0;
  const walk = (node: ChromeBookmarkNode, folder: string): void => {
    if (node.type === 'url' && typeof node.url === 'string') {
      try {
        svc.add({ url: node.url, title: node.name ?? '', folder: folder || null });
        imported++;
      } catch {
        skipped++;
      }
    } else if (node.type === 'folder' && Array.isArray(node.children)) {
      const sub = folder ? `${folder}/${node.name ?? ''}` : node.name ?? '';
      for (const child of node.children) walk(child, sub);
    }
  };
  const roots = json.roots ?? {};
  for (const rootKey of ['bookmark_bar', 'other', 'synced']) {
    const root = roots[rootKey];
    if (!root) continue;
    const rootName = root.name ?? rootKey;
    if (Array.isArray(root.children)) {
      for (const child of root.children) walk(child, rootName);
    }
  }
  return { imported, skipped };
}
