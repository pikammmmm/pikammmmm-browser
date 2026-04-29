import { EventEmitter } from 'node:events';
import { session } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { filtersDir } from '@shared/paths.js';
import type { SettingsService } from './settings.js';

// uBlock Origin's curated filter set, plus EasyList. The uBO lists carry
// scriptlets and cosmetic filters that handle YouTube/Twitch/etc. ads which
// vanilla EasyList misses entirely (YouTube serves preroll ads from the same
// origin as the video, so pure URL blocking can't touch them — uBO's
// scriptlets short-circuit the ad player in JS).
const FILTER_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/filters.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/badware.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/privacy.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/quick-fixes.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/resource-abuse.txt',
  'https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/unbreak.txt',
];

// Bump this when FILTER_LISTS changes so cached engines get re-fetched.
const CACHE_VERSION = 'v2';
const CACHE_FILE = () => join(filtersDir(), `engine.${CACHE_VERSION}.bin`);
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
