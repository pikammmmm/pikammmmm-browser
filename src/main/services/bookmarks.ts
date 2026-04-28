import { randomUUID } from 'node:crypto';
import type { Bookmark } from '@shared/types.js';
import { db } from '../db.js';

export class BookmarksService {
  list(): Bookmark[] {
    const rows = db()
      .prepare(
        `SELECT id, url, title, folder, created_at AS createdAt
         FROM bookmarks
         ORDER BY folder, title`,
      )
      .all() as Bookmark[];
    return rows;
  }

  add(args: { url: string; title: string; folder?: string | null }): Bookmark {
    const id = randomUUID();
    const folder = args.folder ?? null;
    const createdAt = Date.now();
    // Upsert by (url, folder) so re-imports don't duplicate.
    const existing = db()
      .prepare('SELECT id FROM bookmarks WHERE url = ? AND IFNULL(folder, "") = IFNULL(?, "")')
      .get(args.url, folder) as { id: string } | undefined;
    if (existing) {
      db()
        .prepare('UPDATE bookmarks SET title = ? WHERE id = ?')
        .run(args.title, existing.id);
      const row = db()
        .prepare(
          `SELECT id, url, title, folder, created_at AS createdAt FROM bookmarks WHERE id = ?`,
        )
        .get(existing.id) as Bookmark;
      return row;
    }
    db()
      .prepare(
        `INSERT INTO bookmarks (id, url, title, folder, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, args.url, args.title, folder, createdAt);
    return { id, url: args.url, title: args.title, folder, createdAt };
  }

  delete(id: string): void {
    db().prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  }
}
