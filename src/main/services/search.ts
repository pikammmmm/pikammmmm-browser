import type { ImageResult } from '@shared/types.js';
import { KEYCHAIN_KEYS } from '@shared/paths.js';
import { getSecret, setSecret } from '../secrets.js';

interface BraveImageResponse {
  results?: Array<{
    title?: string;
    url?: string;
    thumbnail?: { src?: string };
    properties?: { url?: string };
    source?: string;
    image?: { width?: number; height?: number };
    confidence?: string;
  }>;
}

export class SearchService {
  private async getKey(): Promise<string | null> {
    const env = process.env.BRAVE_API_KEY;
    if (env) return env;
    return getSecret(KEYCHAIN_KEYS.braveKey);
  }

  async setBraveKey(key: string): Promise<void> {
    await setSecret(KEYCHAIN_KEYS.braveKey, key);
  }

  async images(query: string): Promise<ImageResult[]> {
    const key = await this.getKey();
    if (!key) {
      throw new Error('Brave Search API key not set. Add it in Settings.');
    }
    const url = new URL('https://api.search.brave.com/res/v1/images/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', '40');
    url.searchParams.set('safesearch', 'moderate');
    const r = await fetch(url, {
      headers: {
        accept: 'application/json',
        'x-subscription-token': key,
      },
    });
    if (r.status === 429) throw new Error('Brave rate limit hit; try again later.');
    if (!r.ok) throw new Error(`Brave image search failed: ${r.status}`);
    const j = (await r.json()) as BraveImageResponse;
    const results = j.results ?? [];
    return results
      .filter((x) => x.thumbnail?.src && x.url)
      .map<ImageResult>((x) => ({
        thumbnail: x.thumbnail?.src ?? '',
        source_url: x.properties?.url ?? x.url ?? '',
        page_url: x.url ?? '',
        width: x.image?.width ?? 0,
        height: x.image?.height ?? 0,
        title: x.title ?? '',
      }));
  }
}
