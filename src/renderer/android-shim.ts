/**
 * Android/web compatibility shim.
 * Replaces window.claudeBrowser (Electron IPC) with browser-native equivalents:
 * - Tab state: in-memory
 * - Settings / bookmarks / history: localStorage
 * - Claude chat: direct Anthropic API streaming fetch
 * - Web search: Anthropic web_search tool
 * - Image search: unsupported (returns empty)
 */

import type { AuthState, Bookmark, ChatMessage, HistoryEntry, ImageResult, Settings, Tab, TabMode, WebSearchResult } from '@shared/types.js';

// ─── Event bus ──────────────────────────────────────────────────────────────

const listenerMap = new Map<string, Set<(payload: unknown) => void>>();

function emit(channel: string, payload: unknown) {
  listenerMap.get(channel)?.forEach((fn) => fn(payload));
}

function onChannel(channel: string, listener: (payload: unknown) => void) {
  if (!listenerMap.has(channel)) listenerMap.set(channel, new Set());
  listenerMap.get(channel)!.add(listener);
  return () => listenerMap.get(channel)?.delete(listener);
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

function loadLS<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// ─── Tab state ───────────────────────────────────────────────────────────────

let tabCounter = loadLS<number>('tab-counter', 0);
let tabs: Tab[] = [];

function makeTab(opts: { mode: TabMode; url?: string; incognito?: boolean }): Tab {
  const id = `tab-${++tabCounter}`;
  saveLS('tab-counter', tabCounter);
  const label = opts.mode === 'ai' ? 'AI Chat' : opts.mode === 'image' ? 'Image Search' : 'New Tab';
  const tab: Tab = {
    id,
    mode: opts.mode,
    url: opts.url ?? '',
    title: opts.url ? opts.url : label,
    favicon: null,
    query: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    audible: false,
    incognito: opts.incognito ?? false,
  };
  tabs.push(tab);
  return tab;
}

function updateTab(id: string, patch: Partial<Tab>) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  tabs[idx] = { ...tabs[idx], ...patch };
  emit('tab:updated', tabs[idx]);
}

// Start with one default tab
if (tabs.length === 0) {
  makeTab({ mode: 'web' });
}

// ─── Settings ────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  defaultMode: 'web',
  adBlockEnabled: false,
  suspendIdleMinutes: 0,
  claudeModel: 'claude-opus-4-7',
};

let settings: Settings = loadLS<Settings>('pikammm-settings', DEFAULT_SETTINGS);

// ─── Auth ────────────────────────────────────────────────────────────────────

let auth: AuthState = loadLS<AuthState>('pikammm-auth', { signedIn: false, method: 'none' });

// ─── Bookmarks ───────────────────────────────────────────────────────────────

let bookmarks: Bookmark[] = loadLS<Bookmark[]>('pikammm-bookmarks', []);

function saveBookmarks() {
  saveLS('pikammm-bookmarks', bookmarks);
}

// ─── History ─────────────────────────────────────────────────────────────────

let history: HistoryEntry[] = loadLS<HistoryEntry[]>('pikammm-history', []);
let historyIdCounter = loadLS<number>('pikammm-history-id', 0);

function addHistory(url: string, title: string) {
  const entry: HistoryEntry = { id: ++historyIdCounter, url, title, visitedAt: Date.now() };
  history.unshift(entry);
  if (history.length > 1000) history = history.slice(0, 1000);
  saveLS('pikammm-history', history);
  saveLS('pikammm-history-id', historyIdCounter);
}

// ─── Anthropic API helpers ───────────────────────────────────────────────────

const ANTHROPIC_API = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

function apiKey(): string {
  return auth.method === 'apiKey'
    ? (loadLS<string>('pikammm-api-key-val', ''))
    : '';
}

function authHeaders(): Record<string, string> {
  const key = apiKey();
  return {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...(key ? { 'x-api-key': key } : {}),
  };
}

// ─── Web search via Anthropic web_search tool ─────────────────────────────

async function claudeWebSearch(query: string): Promise<WebSearchResult[]> {
  const key = apiKey();
  if (!key) return [];

  const r = await fetch(`${ANTHROPIC_API}/v1/messages`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: settings.claudeModel,
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [
        {
          role: 'user',
          content: `Search the web for: ${query}\n\nReturn ONLY a JSON array of up to 8 results: [{title, url, snippet}]`,
        },
      ],
    }),
  });

  if (!r.ok) return [];

  try {
    const data = (await r.json()) as { content: Array<{ type: string; text?: string }> };
    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        const match = block.text.match(/\[[\s\S]*\]/);
        if (match) return JSON.parse(match[0]) as WebSearchResult[];
      }
    }
  } catch {}
  return [];
}

// ─── Claude chat streaming ────────────────────────────────────────────────────

const activeStreams = new Map<string, AbortController>();

function chatStart(args: { tabId: string; messages: ChatMessage[] }): string {
  const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = apiKey();

  if (!key) {
    setTimeout(() => {
      emit('claude:chatError', {
        streamId,
        error: 'No API key configured. Open Settings and add your Anthropic API key.',
      });
    }, 10);
    return streamId;
  }

  const controller = new AbortController();
  activeStreams.set(streamId, controller);

  (async () => {
    try {
      const response = await fetch(`${ANTHROPIC_API}/v1/messages`, {
        method: 'POST',
        headers: authHeaders(),
        signal: controller.signal,
        body: JSON.stringify({
          model: settings.claudeModel,
          max_tokens: 4096,
          stream: true,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: args.messages,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        emit('claude:chatError', { streamId, error: errText });
        return;
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const ev = JSON.parse(raw) as {
              type: string;
              delta?: { type: string; text?: string };
            };
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
              emit('claude:chatChunk', { streamId, delta: ev.delta.text });
            }
          } catch {}
        }
      }

      emit('claude:chatDone', { streamId });
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') {
        emit('claude:chatError', { streamId, error: String(err) });
      }
    } finally {
      activeStreams.delete(streamId);
    }
  })();

  return streamId;
}

// ─── IPC invoke handler ──────────────────────────────────────────────────────

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    // ── Auth ──────────────────────────────────────────────────────────────
    case 'auth:getState':
      return auth;

    case 'auth:oauthConfigured':
      return false;

    case 'auth:start':
      return;

    case 'auth:signOut':
      auth = { signedIn: false, method: 'none' };
      saveLS('pikammm-auth', auth);
      saveLS('pikammm-api-key-val', '');
      emit('auth:changed', auth);
      return;

    case 'auth:setApiKey': {
      const key = args[0] as string;
      saveLS('pikammm-api-key-val', key);
      auth = { signedIn: !!key, method: key ? 'apiKey' : 'none' };
      saveLS('pikammm-auth', auth);
      emit('auth:changed', auth);
      return auth;
    }

    // ── Settings ──────────────────────────────────────────────────────────
    case 'settings:get':
      return { ...DEFAULT_SETTINGS, ...settings };

    case 'settings:update': {
      const patch = args[0] as Partial<Settings>;
      settings = { ...settings, ...patch };
      saveLS('pikammm-settings', settings);
      return settings;
    }

    // ── Tab management ────────────────────────────────────────────────────
    case 'tab:list':
      return tabs;

    case 'tab:create': {
      const opts = args[0] as { mode: TabMode; url?: string; incognito?: boolean };
      const tab = makeTab(opts);
      return tab;
    }

    case 'tab:close': {
      const id = args[0] as string;
      tabs = tabs.filter((t) => t.id !== id);
      emit('tab:closed', id);
      return;
    }

    case 'tab:closeOthers': {
      const id = args[0] as string;
      const keep = tabs.find((t) => t.id === id);
      tabs = keep ? [keep] : [];
      return;
    }

    case 'tab:closeToRight': {
      const id = args[0] as string;
      const idx = tabs.findIndex((t) => t.id === id);
      if (idx >= 0) tabs = tabs.slice(0, idx + 1);
      return;
    }

    case 'tab:undoClose':
      return;

    case 'tab:navigate': {
      const { tabId, url } = args[0] as { tabId: string; url: string };
      updateTab(tabId, { url, title: url, loading: false });
      addHistory(url, url);
      return;
    }

    case 'tab:setMode': {
      const { tabId, mode, query } = args[0] as { tabId: string; mode: TabMode; query?: string | null };
      updateTab(tabId, { mode, query: query ?? null });
      return;
    }

    case 'tab:reorder': {
      const { fromId, toId } = args[0] as { fromId: string; toId: string };
      const fromIdx = tabs.findIndex((t) => t.id === fromId);
      const toIdx = tabs.findIndex((t) => t.id === toId);
      if (fromIdx >= 0 && toIdx >= 0) {
        const [removed] = tabs.splice(fromIdx, 1);
        tabs.splice(toIdx, 0, removed);
      }
      return;
    }

    case 'tab:setPinned': {
      const { tabId, pinned } = args[0] as { tabId: string; pinned: boolean };
      updateTab(tabId, { pinned });
      return;
    }

    case 'tab:setMuted': {
      const { tabId, muted } = args[0] as { tabId: string; muted: boolean };
      updateTab(tabId, { muted });
      return;
    }

    case 'tab:setBounds':
    case 'tab:show':
    case 'tab:hide':
    case 'tab:goBack':
    case 'tab:goForward':
    case 'tab:reload':
    case 'tab:print':
    case 'tab:toggleDevTools':
    case 'tab:findInPage':
    case 'tab:stopFindInPage':
      return;

    case 'tab:zoomIn':
    case 'tab:zoomOut':
    case 'tab:zoomReset':
      return 1;

    case 'tab:getPageText':
      return '';

    // ── Claude / Search ───────────────────────────────────────────────────
    case 'claude:webSearch':
      return claudeWebSearch(args[0] as string);

    case 'claude:chatStart':
      return chatStart(args[0] as { tabId: string; messages: ChatMessage[] });

    case 'claude:chatCancel': {
      const sid = args[0] as string;
      activeStreams.get(sid)?.abort();
      activeStreams.delete(sid);
      return;
    }

    case 'search:web':
      return claudeWebSearch(args[0] as string);

    case 'search:images':
      return [] as ImageResult[];

    case 'search:setSearchKey':
      return;

    // ── Bookmarks ─────────────────────────────────────────────────────────
    case 'bookmark:list':
      return bookmarks;

    case 'bookmark:listBar':
      return bookmarks.filter((b) => b.inBar);

    case 'bookmark:getByUrl': {
      const url = args[0] as string;
      return bookmarks.filter((b) => b.url === url);
    }

    case 'bookmark:add': {
      const { url, title, folder, inBar } = args[0] as {
        url: string; title: string; folder?: string | null; inBar?: boolean;
      };
      const bm: Bookmark = {
        id: `bm-${Date.now()}`,
        url,
        title,
        folder: folder ?? null,
        createdAt: Date.now(),
        inBar: inBar ?? false,
      };
      bookmarks.push(bm);
      saveBookmarks();
      return bm;
    }

    case 'bookmark:setInBar': {
      const { id, inBar } = args[0] as { id: string; inBar: boolean };
      const bm = bookmarks.find((b) => b.id === id);
      if (bm) { bm.inBar = inBar; saveBookmarks(); }
      return;
    }

    case 'bookmark:delete': {
      const id = args[0] as string;
      bookmarks = bookmarks.filter((b) => b.id !== id);
      saveBookmarks();
      return;
    }

    case 'bookmark:importChrome':
    case 'chrome:listProfiles':
      return { imported: 0, skipped: 0 };

    // ── History ───────────────────────────────────────────────────────────
    case 'history:list': {
      const { search, limit } = (args[0] as { search?: string; limit?: number }) ?? {};
      let res = history;
      if (search) res = res.filter((h) => h.url.includes(search) || h.title.includes(search));
      return limit ? res.slice(0, limit) : res;
    }

    case 'history:clear':
      history = [];
      saveLS('pikammm-history', history);
      return;

    // ── Passwords (stub) ──────────────────────────────────────────────────
    case 'password:list':
    case 'password:getForOrigin':
      return [];

    case 'password:delete':
    case 'password:importChrome':
    case 'password:importCsv':
      return { imported: 0, skipped: 0 };

    // ── Cards (stub) ──────────────────────────────────────────────────────
    case 'card:list':
      return [];

    case 'card:save':
    case 'card:delete':
      return;

    case 'card:getDecrypted':
      return null;

    // ── Ad blocker (stub) ─────────────────────────────────────────────────
    case 'adblock:reload':
      return;

    case 'adblock:stats':
      return { blockedThisSession: 0 };

    default:
      console.warn('[android-shim] unhandled channel:', channel, args);
      return undefined;
  }
}

// ─── Install on window ───────────────────────────────────────────────────────

(window as Window & { claudeBrowser: unknown }).claudeBrowser = { invoke, on: onChannel };
