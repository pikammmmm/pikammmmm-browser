import { randomUUID } from 'node:crypto';
import type { SavedPassword } from '@shared/types.js';
import { db } from '../db.js';
import { decrypt, encrypt, newKey } from '../crypto.js';
import { getSecret, setSecret } from '../secrets.js';
import { KEYCHAIN_KEYS } from '@shared/paths.js';

const REDACT = '••••••••';

export class PasswordService {
  private key: Buffer | null = null;

  async init(): Promise<void> {
    const existing = await getSecret(KEYCHAIN_KEYS.dbKey);
    if (existing) {
      this.key = Buffer.from(existing, 'base64');
      return;
    }
    const k = newKey();
    await setSecret(KEYCHAIN_KEYS.dbKey, k.toString('base64'));
    this.key = k;
  }

  private getKey(): Buffer {
    if (!this.key) throw new Error('PasswordService not initialised');
    return this.key;
  }

  list(): SavedPassword[] {
    const rows = db()
      .prepare('SELECT id, origin, username, updated_at AS updatedAt FROM passwords ORDER BY origin')
      .all() as Array<{ id: string; origin: string; username: string; updatedAt: number }>;
    return rows.map((r) => ({ ...r, password: REDACT }));
  }

  /** Returns cleartext entries. Only call from trusted main-process code paths (page preload). */
  getForOriginCleartext(origin: string): SavedPassword[] {
    const rows = db()
      .prepare(
        'SELECT id, origin, username, password_enc AS passwordEnc, updated_at AS updatedAt FROM passwords WHERE origin = ?',
      )
      .all(origin) as Array<{
      id: string;
      origin: string;
      username: string;
      passwordEnc: string;
      updatedAt: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      origin: r.origin,
      username: r.username,
      password: decrypt(r.passwordEnc, this.getKey()),
      updatedAt: r.updatedAt,
    }));
  }

  /** Renderer-facing variant: redacts the password. */
  getForOrigin(origin: string): SavedPassword[] {
    return this.getForOriginCleartext(origin).map((p) => ({ ...p, password: REDACT }));
  }

  save(origin: string, username: string, password: string): void {
    const enc = encrypt(password, this.getKey());
    const now = Date.now();
    const existing = db()
      .prepare('SELECT id FROM passwords WHERE origin = ? AND username = ?')
      .get(origin, username) as { id: string } | undefined;
    if (existing) {
      db()
        .prepare('UPDATE passwords SET password_enc = ?, updated_at = ? WHERE id = ?')
        .run(enc, now, existing.id);
    } else {
      db()
        .prepare(
          'INSERT INTO passwords (id, origin, username, password_enc, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(randomUUID(), origin, username, enc, now);
    }
  }

  delete(id: string): void {
    db().prepare('DELETE FROM passwords WHERE id = ?').run(id);
  }
}
