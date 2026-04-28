import type { ImageResult } from '@shared/types.js';
import { KEYCHAIN_KEYS } from '@shared/paths.js';
import { getSecret, setSecret } from '../secrets.js';

interface TavilyImage {
  url: string;
  description?: string;
}

interface TavilyResponse {
  images?: Array<TavilyImage | string>;
  results?: Array<{ url?: string; title?: string }>;
}

const TAVILY_URL = 'https://api.tavily.com/search';

export class SearchService {
  private async getKey(): Promise<string | null> {
    const env = process.env.TAVILY_API_KEY;
    if (env) return env;
    return getSecret(KEYCHAIN_KEYS.searchKey);
  }

  async setSearchKey(key: string): Promise<void> {
    await setSecret(KEYCHAIN_KEYS.searchKey, key);
  }

  async images(query: string): Promise<ImageResult[]> {
    const key = await this.getKey();
    if (!key) {
      throw new Error('Tavily API key not set. Add it in Settings.');
    }
    const r = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        include_images: true,
        include_image_descriptions: true,
        max_results: 10,
      }),
    });
    if (r.status === 401) throw new Error('Tavily API key is invalid.');
    if (r.status === 429) throw new Error('Tavily rate limit hit; try again later.');
    if (!r.ok) throw new Error(`Tavily search failed: ${r.status}`);
    const j = (await r.json()) as TavilyResponse;
    const images = j.images ?? [];
    const out: ImageResult[] = [];
    for (const item of images) {
      const isObj = typeof item === 'object' && item !== null;
      const url = isObj ? item.url : item;
      if (!url) continue;
      const title = isObj && item.description ? item.description : '';
      out.push({
        thumbnail: url,
        source_url: url,
        page_url: url,
        width: 0,
        height: 0,
        title,
      });
    }
    return out;
  }
}
