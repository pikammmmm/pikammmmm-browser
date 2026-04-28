import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, WebSearchResult } from '@shared/types.js';
import type { AuthService } from './auth.js';
import type { SettingsService } from './settings.js';

const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; name: string; input: unknown }
    | { type: 'web_search_tool_result'; content: Array<{ url: string; title: string; encrypted_content?: string }> }
  >;
}

export class ClaudeService extends EventEmitter {
  private streams = new Map<string, AbortController>();

  constructor(
    private auth: AuthService,
    private settings: SettingsService,
  ) {
    super();
  }

  private apiUrl(): string {
    return process.env.ANTHROPIC_API_URL ?? 'https://api.anthropic.com';
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const cred = await this.auth.getCredential();
    if (!cred) throw new Error('Not signed in.');
    if (cred.kind === 'bearer') return { authorization: `Bearer ${cred.value}` };
    return { 'x-api-key': cred.value };
  }

  /**
   * Web search via the Anthropic API's web_search tool. Asks Claude to use the tool
   * and emit a JSON list of {title, url, snippet} as the final message.
   */
  async webSearch(query: string): Promise<WebSearchResult[]> {
    const auth = await this.authHeaders();
    const r = await fetch(`${this.apiUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        ...auth,
      },
      body: JSON.stringify({
        model: this.settings.get().claudeModel,
        max_tokens: 2048,
        system:
          'You are a search engine. Use the web_search tool, then return ONLY a JSON array of the top 8 most relevant results in the form ' +
          '[{"title":"...","url":"...","snippet":"..."}]. No prose, no preamble. JSON only.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
        messages: [{ role: 'user', content: query }],
      }),
    });
    if (!r.ok) throw new Error(`Claude web search failed: ${r.status} ${await r.text().catch(() => '')}`);
    const j = (await r.json()) as AnthropicResponse;
    const lastText = [...j.content].reverse().find((b) => b.type === 'text');
    if (!lastText || lastText.type !== 'text') {
      return this.extractFallbackResults(j);
    }
    return this.parseJsonArray(lastText.text) ?? this.extractFallbackResults(j);
  }

  private parseJsonArray(text: string): WebSearchResult[] | null {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const arr = JSON.parse(match[0]) as unknown;
      if (!Array.isArray(arr)) return null;
      return arr
        .filter((x): x is WebSearchResult =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as WebSearchResult).title === 'string' &&
          typeof (x as WebSearchResult).url === 'string',
        )
        .map((x) => ({
          title: x.title,
          url: x.url,
          snippet: typeof x.snippet === 'string' ? x.snippet : '',
        }));
    } catch {
      return null;
    }
  }

  private extractFallbackResults(j: AnthropicResponse): WebSearchResult[] {
    const out: WebSearchResult[] = [];
    for (const block of j.content) {
      if (block.type === 'web_search_tool_result') {
        for (const r of block.content) {
          out.push({ title: r.title, url: r.url, snippet: '' });
        }
      }
    }
    return out.slice(0, 8);
  }

  /**
   * Streaming chat for AI mode. Returns a streamId; chunks are emitted as
   * 'chatChunk' events on this service.
   */
  async chatStart(messages: ChatMessage[]): Promise<string> {
    const streamId = randomUUID();
    const ac = new AbortController();
    this.streams.set(streamId, ac);

    void this.runChatStream(streamId, messages, ac.signal).catch((err: Error) => {
      this.emit('chatError', { streamId, error: err.message });
      this.streams.delete(streamId);
    });
    return streamId;
  }

  chatCancel(streamId: string): void {
    const ac = this.streams.get(streamId);
    if (ac) {
      ac.abort();
      this.streams.delete(streamId);
    }
  }

  private async runChatStream(
    streamId: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    const auth = await this.authHeaders();
    const r = await fetch(`${this.apiUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        accept: 'text/event-stream',
        ...auth,
      },
      body: JSON.stringify({
        model: this.settings.get().claudeModel,
        max_tokens: 4096,
        stream: true,
        messages,
      }),
      signal,
    });
    if (!r.ok || !r.body) throw new Error(`Claude chat failed: ${r.status}`);

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const evt = JSON.parse(payload) as {
            type: string;
            delta?: { type?: string; text?: string };
          };
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
            this.emit('chatChunk', { streamId, delta: evt.delta.text });
          }
        } catch {
          /* skip malformed line */
        }
      }
    }
    this.emit('chatDone', { streamId });
    this.streams.delete(streamId);
  }
}
