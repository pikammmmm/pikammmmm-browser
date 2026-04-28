import { app } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function userDataDir(): string {
  return app.getPath('userData');
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

export function dbPath(): string {
  return join(userDataDir(), 'data.db');
}

export function settingsPath(): string {
  return join(userDataDir(), 'settings.json');
}

export function sessionPath(): string {
  return join(userDataDir(), 'session.json');
}

export function filtersDir(): string {
  return ensureDir(join(userDataDir(), 'filters'));
}

export function logsDir(): string {
  return ensureDir(join(userDataDir(), 'logs'));
}

export const KEYCHAIN_SERVICE = 'claude-browser';
export const KEYCHAIN_KEYS = {
  oauthRefresh: 'oauth-refresh-token',
  oauthAccess: 'oauth-access-token',
  apiKey: 'anthropic-api-key',
  searchKey: 'tavily-api-key',
  dbKey: 'db-encryption-key',
} as const;
