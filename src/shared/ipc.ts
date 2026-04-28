import type {
  AdblockStats,
  AuthState,
  ChatMessage,
  HistoryEntry,
  ImageResult,
  SavedCard,
  SavedPassword,
  Settings,
  Tab,
  TabMode,
  WebSearchResult,
} from './types.js';

/** Channels invoked renderer→main with a response. */
export interface IpcInvoke {
  'auth:start': () => void;
  'auth:signOut': () => void;
  'auth:getState': () => AuthState;
  'auth:oauthConfigured': () => boolean;
  'auth:setApiKey': (key: string) => AuthState;

  'claude:webSearch': (query: string) => WebSearchResult[];
  'claude:chatStart': (args: { tabId: string; messages: ChatMessage[] }) => string;
  'claude:chatCancel': (streamId: string) => void;

  'search:images': (query: string) => ImageResult[];
  'search:setSearchKey': (key: string) => void;

  'tab:create': (opts: { mode: TabMode; url?: string }) => Tab;
  'tab:close': (tabId: string) => void;
  'tab:list': () => Tab[];
  'tab:navigate': (args: { tabId: string; url: string }) => void;
  'tab:setMode': (args: { tabId: string; mode: TabMode; query?: string | null }) => void;
  'tab:setBounds': (args: {
    tabId: string;
    bounds: { x: number; y: number; width: number; height: number };
  }) => void;
  'tab:show': (tabId: string) => void;
  'tab:hide': (tabId: string) => void;
  'tab:goBack': (tabId: string) => void;
  'tab:goForward': (tabId: string) => void;
  'tab:reload': (tabId: string) => void;

  'history:list': (opts: { search?: string; limit?: number }) => HistoryEntry[];
  'history:clear': () => void;

  'password:list': () => SavedPassword[];
  'password:save': (args: { origin: string; username: string; password: string }) => void;
  'password:delete': (id: string) => void;
  'password:getForOrigin': (origin: string) => SavedPassword[];

  'card:list': () => SavedCard[];
  'card:save': (
    card: Omit<SavedCard, 'id' | 'lastFour' | 'updatedAt'>,
  ) => void;
  'card:delete': (id: string) => void;
  /** Triggers Windows Hello / OS re-auth before returning cleartext. */
  'card:getDecrypted': (id: string) => SavedCard | null;

  'settings:get': () => Settings;
  'settings:update': (patch: Partial<Settings>) => Settings;

  'adblock:reload': () => void;
  'adblock:stats': () => AdblockStats;
}

/** Events pushed main→renderer. */
export interface IpcEvents {
  'auth:changed': AuthState;
  'tab:updated': Tab;
  'tab:closed': string;
  'claude:chatChunk': { streamId: string; delta: string };
  'claude:chatDone': { streamId: string };
  'claude:chatError': { streamId: string; error: string };
  'password:savePrompt': { tabId: string; origin: string; username: string };
  'adblock:statsUpdated': AdblockStats;
}

export const INVOKE_CHANNELS: Array<keyof IpcInvoke> = [
  'auth:start',
  'auth:signOut',
  'auth:getState',
  'auth:oauthConfigured',
  'auth:setApiKey',
  'claude:webSearch',
  'claude:chatStart',
  'claude:chatCancel',
  'search:images',
  'search:setSearchKey',
  'tab:create',
  'tab:close',
  'tab:list',
  'tab:navigate',
  'tab:setMode',
  'tab:setBounds',
  'tab:show',
  'tab:hide',
  'tab:goBack',
  'tab:goForward',
  'tab:reload',
  'history:list',
  'history:clear',
  'password:list',
  'password:save',
  'password:delete',
  'password:getForOrigin',
  'card:list',
  'card:save',
  'card:delete',
  'card:getDecrypted',
  'settings:get',
  'settings:update',
  'adblock:reload',
  'adblock:stats',
];

export const EVENT_CHANNELS: Array<keyof IpcEvents> = [
  'auth:changed',
  'tab:updated',
  'tab:closed',
  'claude:chatChunk',
  'claude:chatDone',
  'claude:chatError',
  'password:savePrompt',
  'adblock:statsUpdated',
];
