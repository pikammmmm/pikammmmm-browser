import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { Settings } from '@shared/types.js';
import { settingsPath } from '@shared/paths.js';

const DEFAULTS: Settings = {
  theme: 'system',
  defaultMode: 'web',
  adBlockEnabled: true,
  suspendIdleMinutes: 10,
  claudeModel: process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6',
};

let cache: Settings | null = null;

export class SettingsService {
  get(): Settings {
    if (cache) return cache;
    const path = settingsPath();
    if (!existsSync(path)) {
      cache = { ...DEFAULTS };
      writeFileSync(path, JSON.stringify(cache, null, 2));
      return cache;
    }
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings>;
      // Migrate stale model default from earlier builds.
      if (raw.claudeModel === 'claude-opus-4-7') {
        delete raw.claudeModel;
      }
      cache = { ...DEFAULTS, ...raw };
    } catch {
      cache = { ...DEFAULTS };
    }
    return cache;
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch };
    cache = next;
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
    return next;
  }
}
