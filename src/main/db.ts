import Database from 'better-sqlite3';
import { dbPath } from '@shared/paths.js';

let dbInstance: Database.Database | null = null;

export function db(): Database.Database {
  if (dbInstance) return dbInstance;
  const conn = new Database(dbPath());
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.exec(SCHEMA);
  // Idempotent migrations — wrapped because they fail with "duplicate column"
  // on subsequent runs.
  for (const stmt of MIGRATIONS) {
    try {
      conn.exec(stmt);
    } catch {
      /* already applied */
    }
  }
  dbInstance = conn;
  return conn;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_visited_idx ON history (visited_at DESC);
CREATE INDEX IF NOT EXISTS history_url_idx ON history (url);

CREATE TABLE IF NOT EXISTS passwords (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (origin, username)
);
CREATE INDEX IF NOT EXISTS passwords_origin_idx ON passwords (origin);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  cardholder_name TEXT NOT NULL,
  number_enc TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  nickname TEXT,
  last_four TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  folder TEXT,
  created_at INTEGER NOT NULL,
  in_bar INTEGER NOT NULL DEFAULT 0,
  UNIQUE (url, folder)
);
CREATE INDEX IF NOT EXISTS bookmarks_folder_idx ON bookmarks (folder);
`;

const MIGRATIONS = [
  `ALTER TABLE bookmarks ADD COLUMN in_bar INTEGER NOT NULL DEFAULT 0;`,
  `CREATE INDEX IF NOT EXISTS bookmarks_in_bar_idx ON bookmarks (in_bar);`,
];
