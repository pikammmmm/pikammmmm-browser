import { randomUUID } from 'node:crypto';
import type { Bookmark } from '@shared/types.js';
import { db } from '../db.js';

interface DbRow {
  id: string;
  url: string;
  title: string;
  folder: string | null;
  createdAt: number;
  in_bar: number;
}

function rowToPublic(r: DbRow): Bookmark {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    folder: r.folder,
    createdAt: r.createdAt,
    inBar: r.in_bar === 1,
  };
}

export class BookmarksService {
  list(): Bookmark[] {
    const rows = db()
      .prepare(
        `SELECT id, url, title, folder, created_at AS createdAt, in_bar
         FROM bookmarks
         ORDER BY in_bar DESC, folder, title`,
      )
      .all() as DbRow[];
    return rows.map(rowToPublic);
  }

  listInBar(): Bookmark[] {
    const rows = db()
      .prepare(
        `SELECT id, url, title, folder, created_at AS createdAt, in_bar
         FROM bookmarks
         WHERE in_bar = 1
         ORDER BY created_at`,
      )
      .all() as DbRow[];
    return rows.map(rowToPublic);
  }

  getByUrl(url: string): Bookmark[] {
    const rows = db()
      .prepare(
        `SELECT id, url, title, folder, created_at AS createdAt, in_bar
         FROM bookmarks WHERE url = ?`,
      )
      .all(url) as DbRow[];
    return rows.map(rowToPublic);
  }

  setInBar(id: string, inBar: boolean): void {
    db()
      .prepare('UPDATE bookmarks SET in_bar = ? WHERE id = ?')
      .run(inBar ? 1 : 0, id);
  }

  add(args: { url: string; title: string; folder?: string | null; inBar?: boolean }): Bookmark {
    const folder = args.folder ?? null;
    const inBarVal = args.inBar ? 1 : 0;
    const createdAt = Date.now();
    const existing = db()
      .prepare('SELECT id FROM bookmarks WHERE url = ? AND IFNULL(folder, "") = IFNULL(?, "")')
      .get(args.url, folder) as { id: string } | undefined;
    if (existing) {
      db()
        .prepare('UPDATE bookmarks SET title = ?, in_bar = MAX(in_bar, ?) WHERE id = ?')
        .run(args.title, inBarVal, existing.id);
      const row = db()
        .prepare(
          `SELECT id, url, title, folder, created_at AS createdAt, in_bar
           FROM bookmarks WHERE id = ?`,
        )
        .get(existing.id) as DbRow;
      return rowToPublic(row);
    }
    const id = randomUUID();
    db()
      .prepare(
        `INSERT INTO bookmarks (id, url, title, folder, created_at, in_bar)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, args.url, args.title, folder, createdAt, inBarVal);
    return { id, url: args.url, title: args.title, folder, createdAt, inBar: !!args.inBar };
  }

  delete(id: string): void {
    db().prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }
}
