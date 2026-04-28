import { create } from 'zustand';
import type {
  AuthState,
  ChatMessage,
  ImageResult,
  Settings,
  Tab,
  TabMode,
  WebSearchResult,
} from '@shared/types.js';
import { api } from './api.js';

export interface TabUIState {
  /** Last submitted query for web/image mode. null = no query yet (show new tab page). */
  query: string | null;
  webResults: WebSearchResult[] | null;
  webError: string | null;
  webLoading: boolean;
  imageResults: ImageResult[] | null;
  imageError: string | null;
  imageLoading: boolean;
  aiMessages: ChatMessage[];
  aiStreamId: string | null;
  aiError: string | null;
}

const blankUIState = (): TabUIState => ({
  query: null,
  webResults: null,
  webError: null,
  webLoading: false,
  imageResults: null,
  imageError: null,
  imageLoading: false,
  aiMessages: [],
  aiStreamId: null,
  aiError: null,
});

interface AppState {
  auth: AuthState;
  settings: Settings | null;
  tabs: Tab[];
  ui: Record<string, TabUIState>;
  activeTabId: string | null;
  showSettings: boolean;

  bootstrap: () => Promise<void>;
  setActive: (id: string) => void;
  newTab: (mode?: TabMode) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  setMode: (id: string, mode: TabMode) => Promise<void>;
  submitQuery: (id: string, raw: string) => Promise<void>;
  navigateUrl: (id: string, url: string) => Promise<void>;
  goBack: (id: string) => void;
  goForward: (id: string) => void;
  reload: (id: string) => void;
  toggleSettings: (open?: boolean) => void;

  applyTabUpdate: (tab: Tab) => void;
  applyTabClosed: (id: string) => void;
  applyChatChunk: (streamId: string, delta: string) => void;
  applyChatDone: (streamId: string) => void;
  applyChatError: (streamId: string, error: string) => void;
  applyAuthChanged: (state: AuthState) => void;
}

function isUrlLike(input: string): boolean {
  if (!input) return false;
  if (/^https?:\/\//i.test(input)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(input.trim())) return true;
  return false;
}

function normalizeUrl(input: string): string {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

export const useApp = create<AppState>((set, get) => ({
  auth: { signedIn: false, method: 'none' },
  settings: null,
  tabs: [],
  ui: {},
  activeTabId: null,
  showSettings: false,

  async bootstrap() {
    const [auth, settings, tabs] = await Promise.all([
      api.invoke('auth:getState'),
      api.invoke('settings:get'),
      api.invoke('tab:list'),
    ]);
    set({ auth, settings, tabs });
    if (tabs.length === 0) {
      await get().newTab(settings.defaultMode);
    } else {
      const id = tabs[0]!.id;
      set({ activeTabId: id });
      await api.invoke('tab:show', id);
    }
  },

  async newTab(mode?: TabMode) {
    const m = mode ?? get().settings?.defaultMode ?? 'web';
    const tab = await api.invoke('tab:create', { mode: m });
    set((s) => ({
      tabs: [...s.tabs, tab],
      ui: { ...s.ui, [tab.id]: blankUIState() },
      activeTabId: tab.id,
      showSettings: false,
    }));
    await api.invoke('tab:show', tab.id);
  },

  async closeTab(id: string) {
    await api.invoke('tab:close', id);
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const ui = { ...s.ui };
      delete ui[id];
      let next = s.activeTabId;
      if (next === id) next = tabs[0]?.id ?? null;
      return { tabs, ui, activeTabId: next };
    });
    const next = get().activeTabId;
    if (next) await api.invoke('tab:show', next);
  },

  setActive(id) {
    set({ activeTabId: id, showSettings: false });
    void api.invoke('tab:show', id);
  },

  async setMode(id, mode) {
    await api.invoke('tab:setMode', { tabId: id, mode });
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, mode } : t)),
    }));
  },

  async submitQuery(id, raw) {
    const input = raw.trim();
    if (!input) return;
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;

    if (tab.mode === 'web' && isUrlLike(input)) {
      await get().navigateUrl(id, normalizeUrl(input));
      return;
    }

    set((s) => ({
      ui: {
        ...s.ui,
        [id]: {
          ...(s.ui[id] ?? blankUIState()),
          query: input,
          webResults: tab.mode === 'web' ? null : s.ui[id]?.webResults ?? null,
          webError: null,
          webLoading: tab.mode === 'web',
          imageResults: tab.mode === 'image' ? null : s.ui[id]?.imageResults ?? null,
          imageError: null,
          imageLoading: tab.mode === 'image',
          aiMessages:
            tab.mode === 'ai'
              ? [...(s.ui[id]?.aiMessages ?? []), { role: 'user', content: input }]
              : s.ui[id]?.aiMessages ?? [],
          aiError: null,
        },
      },
    }));

    await api.invoke('tab:hide', id);

    try {
      if (tab.mode === 'web') {
        const results = await api.invoke('claude:webSearch', input);
        set((s) => ({
          ui: { ...s.ui, [id]: { ...(s.ui[id] ?? blankUIState()), webResults: results, webLoading: false } },
        }));
      } else if (tab.mode === 'image') {
        const results = await api.invoke('search:images', input);
        set((s) => ({
          ui: { ...s.ui, [id]: { ...(s.ui[id] ?? blankUIState()), imageResults: results, imageLoading: false } },
        }));
      } else {
        const messages = get().ui[id]?.aiMessages ?? [];
        const streamId = await api.invoke('claude:chatStart', { tabId: id, messages });
        set((s) => ({
          ui: {
            ...s.ui,
            [id]: {
              ...(s.ui[id] ?? blankUIState()),
              aiStreamId: streamId,
              aiMessages: [...messages, { role: 'assistant', content: '' }],
            },
          },
        }));
      }
    } catch (e: unknown) {
      const msg = (e as Error).message ?? 'Request failed';
      set((s) => ({
        ui: {
          ...s.ui,
          [id]: {
            ...(s.ui[id] ?? blankUIState()),
            webError: tab.mode === 'web' ? msg : null,
            imageError: tab.mode === 'image' ? msg : null,
            aiError: tab.mode === 'ai' ? msg : null,
            webLoading: false,
            imageLoading: false,
          },
        },
      }));
    }
  },

  async navigateUrl(id, url) {
    set((s) => ({
      ui: {
        ...s.ui,
        [id]: {
          ...(s.ui[id] ?? blankUIState()),
          query: null,
          webResults: null,
          webError: null,
          imageResults: null,
          imageError: null,
        },
      },
    }));
    await api.invoke('tab:navigate', { tabId: id, url });
    await api.invoke('tab:show', id);
  },

  goBack(id) {
    void api.invoke('tab:goBack', id);
  },
  goForward(id) {
    void api.invoke('tab:goForward', id);
  },
  reload(id) {
    void api.invoke('tab:reload', id);
  },

  toggleSettings(open) {
    set((s) => ({ showSettings: open ?? !s.showSettings }));
    if (open ?? !get().showSettings) {
      const id = get().activeTabId;
      if (id) void api.invoke('tab:hide', id);
    } else {
      const id = get().activeTabId;
      if (id) void api.invoke('tab:show', id);
    }
  },

  applyTabUpdate(tab) {
    set((s) => ({
      tabs: s.tabs.some((t) => t.id === tab.id)
        ? s.tabs.map((t) => (t.id === tab.id ? tab : t))
        : [...s.tabs, tab],
    }));
  },

  applyTabClosed(id) {
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const ui = { ...s.ui };
      delete ui[id];
      return { tabs, ui };
    });
  },

  applyChatChunk(streamId, delta) {
    set((s) => {
      const entries = Object.entries(s.ui);
      const found = entries.find(([, u]) => u.aiStreamId === streamId);
      if (!found) return s;
      const [tabId, u] = found;
      const last = u.aiMessages[u.aiMessages.length - 1];
      if (!last || last.role !== 'assistant') return s;
      const newMessages = [
        ...u.aiMessages.slice(0, -1),
        { ...last, content: last.content + delta },
      ];
      return {
        ui: { ...s.ui, [tabId]: { ...u, aiMessages: newMessages } },
      };
    });
  },

  applyChatDone(streamId) {
    set((s) => {
      const entries = Object.entries(s.ui);
      const found = entries.find(([, u]) => u.aiStreamId === streamId);
      if (!found) return s;
      const [tabId, u] = found;
      return { ui: { ...s.ui, [tabId]: { ...u, aiStreamId: null } } };
    });
  },

  applyChatError(streamId, error) {
    set((s) => {
      const entries = Object.entries(s.ui);
      const found = entries.find(([, u]) => u.aiStreamId === streamId);
      if (!found) return s;
      const [tabId, u] = found;
      return { ui: { ...s.ui, [tabId]: { ...u, aiStreamId: null, aiError: error } } };
    });
  },

  applyAuthChanged(state) {
    set({ auth: state });
  },
}));
