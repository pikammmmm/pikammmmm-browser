import type { HistoryEntry } from '@shared/types.js';
import { db } from '../db.js';

export class HistoryService {
  log(url: string, title: string): void {
    if (!url || url.startsWith('about:') || url.startsWith('chrome:')) return;
    db()
      .prepare('INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)')
      .run(url, title, Date.now());
  }

  list(opts: { search?: string; limit?: number }): HistoryEntry[] {
    const limit = Math.min(opts.limit ?? 200, 1000);
    if (opts.search) {
      const q = `%${opts.search}%`;
      return db()
        .prepare(
          `SELECT id, url, title, visited_at AS visitedAt
           FROM history
           WHERE url LIKE ? OR title LIKE ?
           ORDER BY visited_at DESC
           LIMIT ?`,
        )
        .all(q, q, limit) as HistoryEntry[];
    }
    return db()
      .prepare(
        `SELECT id, url, title, visited_at AS visitedAt
         FROM history
         ORDER BY visited_at DESC
         LIMIT ?`,
      )
      .all(limit) as HistoryEntry[];
  }

  clear(): void {
    db().prepare('DELETE FROM history').run();
  }
}
