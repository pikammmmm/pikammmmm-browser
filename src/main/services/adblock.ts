import { EventEmitter } from 'node:events';
import { session } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { filtersDir } from '@shared/paths.js';
import type { SettingsService } from './settings.js';

const FILTER_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext',
];

const CACHE_FILE = () => join(filtersDir(), 'engine.bin');
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class AdblockService extends EventEmitter {
  private blocker: ElectronBlocker | null = null;
  private blockedThisSession = 0;

  constructor(private settings: SettingsService) {
    super();
  }

  async init(): Promise<void> {
    if (!this.settings.get().adBlockEnabled) return;
    this.blocker = await this.loadOrFetchEngine();
    this.blocker.enableBlockingInSession(session.defaultSession);
    this.blocker.on('request-blocked', () => {
      this.blockedThisSession += 1;
      this.emit('statsUpdated', { blockedThisSession: this.blockedThisSession });
    });
  }

  async reload(): Promise<void> {
    if (this.blocker) this.blocker.disableBlockingInSession(session.defaultSession);
    this.blocker = await ElectronBlocker.fromLists(fetch, FILTER_LISTS, { enableCompression: true });
    writeFileSync(CACHE_FILE(), this.blocker.serialize());
    this.blocker.enableBlockingInSession(session.defaultSession);
  }

  stats(): { blockedThisSession: number } {
    return { blockedThisSession: this.blockedThisSession };
  }

  private async loadOrFetchEngine(): Promise<ElectronBlocker> {
    const cache = CACHE_FILE();
    const stale = !existsSync(cache) || Date.now() - statMtime(cache) > ONE_WEEK_MS;
    if (!stale) {
      try {
        return ElectronBlocker.deserialize(new Uint8Array(readFileSync(cache)));
      } catch {
        /* fall through and refetch */
      }
    }
    const blocker = await ElectronBlocker.fromLists(fetch, FILTER_LISTS, { enableCompression: true });
    try {
      writeFileSync(cache, blocker.serialize());
    } catch {
      /* cache write is best-effort */
    }
    return blocker;
  }
}

function statMtime(path: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:fs').statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
