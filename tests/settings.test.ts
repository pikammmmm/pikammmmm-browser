import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'cb-settings-'));

vi.mock('electron', () => ({
  app: { getPath: () => tmp },
}));

beforeAll(async () => {
  // mock applies before SettingsService is imported below
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('SettingsService', () => {
  it('returns defaults on first call and persists overrides across reloads', async () => {
    const { SettingsService } = await import('../src/main/services/settings.js');
    const s = new SettingsService();
    const a = s.get();
    expect(a.defaultMode).toBe('web');
    expect(a.adBlockEnabled).toBe(true);
    s.update({ defaultMode: 'ai', suspendIdleMinutes: 5 });

    // module-level cache is internal; instantiating again still hits the same in-memory cache,
    // but we verify the persisted JSON file by reading the disk write directly via a fresh import.
    vi.resetModules();
    const fresh = await import('../src/main/services/settings.js');
    const b = new fresh.SettingsService();
    const c = b.get();
    expect(c.defaultMode).toBe('ai');
    expect(c.suspendIdleMinutes).toBe(5);
  });
});
