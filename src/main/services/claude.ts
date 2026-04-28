import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, WebSearchResult } from '@shared/types.js';
import type { AuthService } from './auth.js';
import type { SettingsService } from './settings.js';

export interface AgentTools {
  /** Open a URL as a new web tab. Returns nothing important to the model. */
  openTab: (url: string, title?: string) => void;
  /** Run a Tavily web search and return top results. */
  webSearch: (query: string) => Promise<WebSearchResult[]>;
}

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
  private agentTools: AgentTools | null = null;

  constructor(
    private auth: AuthService,
    private settings: SettingsService,
  ) {
    super();
  }

  setAgentTools(tools: AgentTools): void {
    this.agentTools = tools;
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
        max_tokens: 4096,
        system:
          'You are a search engine. Use the web_search tool, then return ONLY a JSON array of the top 20 most relevant results in the form ' +
          '[{"title":"...","url":"...","snippet":"..."}]. No prose, no preamble. JSON only.',
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
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
    return out.slice(0, 20);
  }

  /**
   * Streaming chat for AI mode. Returns a streamId; chunks are emitted as
   * 'chatChunk' events on this service.
   *
   * If agent tools are wired up, Claude can call open_tab() and web_search()
   * to act on the user's behalf — making "open me some news articles" actually
   * open them.
   */
  async chatStart(messages: ChatMessage[]): Promise<string> {
    const streamId = randomUUID();
    const ac = new AbortController();
    this.streams.set(streamId, ac);

    const runner = this.agentTools
      ? this.runAgentStream(streamId, messages, ac.signal)
      : this.runChatStream(streamId, messages, ac.signal);

    void runner.catch((err: Error) => {
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

  /**
   * Agent loop. Uses the messages API non-streaming for simpler tool wiring;
   * emits chunks per turn so the chat still feels live. Up to 10 tool-use
   * iterations to prevent runaway.
   */
  private async runAgentStream(
    streamId: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<void> {
    const tools = this.agentTools!;
    const auth = await this.authHeaders();
    const toolDefs = [
      {
        name: 'open_tab',
        description:
          'Open a URL in a new browser tab. Use this when the user asks you to open / pull up / navigate to something — actually do it, don\'t just suggest links.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full https URL' },
            title: { type: 'string', description: 'Optional human-readable title' },
          },
          required: ['url'],
        },
      },
      {
        name: 'web_search',
        description:
          'Search the live web for current information. Use whenever you need facts you can\'t reliably know (recent news, prices, schedules, etc).',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query' },
          },
          required: ['query'],
        },
      },
    ];

    const working: Array<{
      role: 'user' | 'assistant';
      content: string | unknown[];
    }> = messages.map((m) => ({ role: m.role, content: m.content }));

    for (let iter = 0; iter < 10; iter++) {
      if (signal.aborted) return;

      const r = await fetch(`${this.apiUrl()}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          ...auth,
        },
        body: JSON.stringify({
          model: this.settings.get().claudeModel,
          max_tokens: 4096,
          system:
            'You are Claude, integrated into a desktop browser. When the user asks you to open / show / pull up content, use the open_tab tool to do it for real. When you need current information, use web_search. Keep replies concise.',
          tools: toolDefs,
          messages: working,
        }),
        signal,
      });
      if (!r.ok) {
        throw new Error(`Claude agent failed: ${r.status} ${await r.text().catch(() => '')}`);
      }
      const j = (await r.json()) as {
        content: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
        >;
        stop_reason: string;
      };

      const assistantBlocks = j.content;
      working.push({ role: 'assistant', content: assistantBlocks });

      // Stream visible text + a one-line indicator per tool call.
      for (const block of assistantBlocks) {
        if (block.type === 'text' && block.text) {
          this.emit('chatChunk', { streamId, delta: block.text });
        } else if (block.type === 'tool_use') {
          const indicator =
            block.name === 'open_tab'
              ? `\n\n_🌐 opening **${(block.input.title as string) || (block.input.url as string)}**_`
              : `\n\n_🔍 searching: **${block.input.query as string}**_`;
          this.emit('chatChunk', { streamId, delta: indicator });
        }
      }

      if (j.stop_reason !== 'tool_use') {
        this.emit('chatDone', { streamId });
        this.streams.delete(streamId);
        return;
      }

      // Execute every tool_use block this turn produced, in order.
      const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string }> = [];
      for (const block of assistantBlocks) {
        if (block.type !== 'tool_use') continue;
        let result: string;
        try {
          if (block.name === 'open_tab') {
            const url = block.input.url as string;
            tools.openTab(url, block.input.title as string | undefined);
            result = `Opened tab to ${url}`;
          } else if (block.name === 'web_search') {
            const results = await tools.webSearch(block.input.query as string);
            result = JSON.stringify(results.slice(0, 10));
          } else {
            result = `Unknown tool: ${block.name}`;
          }
        } catch (err) {
          result = `Tool error: ${(err as Error).message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
      working.push({ role: 'user', content: toolResults });
      this.emit('chatChunk', { streamId, delta: '\n\n' });
    }

    // Hit the iteration cap.
    this.emit('chatDone', { streamId });
    this.streams.delete(streamId);
  }
}
