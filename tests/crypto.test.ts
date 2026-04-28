import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, newKey } from '../src/main/crypto.js';

describe('crypto', () => {
  it('round-trips text under a fresh key', () => {
    const key = newKey();
    const ct = encrypt('hello world', key);
    expect(decrypt(ct, key)).toBe('hello world');
  });

  it('rejects ciphertext under a different key', () => {
    const a = newKey();
    const b = newKey();
    const ct = encrypt('secret', a);
    expect(() => decrypt(ct, b)).toThrow();
  });

  it('rejects tampered ciphertext (auth tag check)', () => {
    const key = newKey();
    const ct = encrypt('secret', key);
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0x01;
    expect(() => decrypt(buf.toString('base64'), key)).toThrow();
  });

  it('refuses keys that are not 32 bytes', () => {
    const short = Buffer.alloc(16);
    expect(() => encrypt('x', short)).toThrow();
  });
});
