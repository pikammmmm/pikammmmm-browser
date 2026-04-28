import { randomUUID } from 'node:crypto';
import type { SavedCard } from '@shared/types.js';
import { db } from '../db.js';
import { decrypt, encrypt } from '../crypto.js';
import { getSecret } from '../secrets.js';
import { KEYCHAIN_KEYS } from '@shared/paths.js';

const REDACT_NUMBER = '•••• •••• •••• ';

export class CardService {
  private key: Buffer | null = null;

  async init(): Promise<void> {
    const k = await getSecret(KEYCHAIN_KEYS.dbKey);
    if (!k) throw new Error('CardService: db key missing (init PasswordService first)');
    this.key = Buffer.from(k, 'base64');
  }

  private getKey(): Buffer {
    if (!this.key) throw new Error('CardService not initialised');
    return this.key;
  }

  list(): SavedCard[] {
    const rows = db()
      .prepare(
        'SELECT id, cardholder_name AS cardholderName, exp_month AS expMonth, exp_year AS expYear, nickname, last_four AS lastFour, updated_at AS updatedAt FROM cards ORDER BY updated_at DESC',
      )
      .all() as Array<Omit<SavedCard, 'number'>>;
    return rows.map<SavedCard>((r) => ({
      ...r,
      number: REDACT_NUMBER + r.lastFour,
    }));
  }

  save(card: Omit<SavedCard, 'id' | 'lastFour' | 'updatedAt'>): void {
    const digits = card.number.replace(/\D/g, '');
    if (digits.length < 12 || digits.length > 19) {
      throw new Error('Card number looks invalid.');
    }
    const lastFour = digits.slice(-4);
    const enc = encrypt(digits, this.getKey());
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO cards (id, cardholder_name, number_enc, exp_month, exp_year, nickname, last_four, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        card.cardholderName,
        enc,
        card.expMonth,
        card.expYear,
        card.nickname,
        lastFour,
        now,
      );
  }

  delete(id: string): void {
    db().prepare('DELETE FROM cards WHERE id = ?').run(id);
  }

  /**
   * Cleartext fetch. The OS-auth gate is enforced by the IPC handler in src/main/index.ts
   * (`confirmCardAccess`) before this method is called — never expose this directly.
   */
  getDecrypted(id: string): SavedCard | null {
    const row = db()
      .prepare(
        `SELECT id, cardholder_name AS cardholderName, number_enc AS numberEnc,
                exp_month AS expMonth, exp_year AS expYear, nickname,
                last_four AS lastFour, updated_at AS updatedAt
         FROM cards WHERE id = ?`,
      )
      .get(id) as
      | (Omit<SavedCard, 'number'> & { numberEnc: string })
      | undefined;
    if (!row) return null;
    const number = decrypt(row.numberEnc, this.getKey());
    return {
      id: row.id,
      cardholderName: row.cardholderName,
      number,
      expMonth: row.expMonth,
      expYear: row.expYear,
      nickname: row.nickname,
      lastFour: row.lastFour,
      updatedAt: row.updatedAt,
    };
  }
}
