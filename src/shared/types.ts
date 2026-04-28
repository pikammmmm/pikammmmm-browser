export type TabMode = 'web' | 'image' | 'ai';

export interface AuthState {
  signedIn: boolean;
  method: 'none' | 'oauth' | 'apiKey';
  email?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ImageResult {
  thumbnail: string;
  source_url: string;
  page_url: string;
  width: number;
  height: number;
  title: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Tab {
  id: string;
  mode: TabMode;
  url: string;
  title: string;
  favicon: string | null;
  query: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface SavedPassword {
  id: string;
  origin: string;
  username: string;
  /** Returned to renderer ONLY in lists where it's redacted as "********". The actual cleartext is only released to content scripts in the page preload context. */
  password: string;
  updatedAt: number;
}

export interface SavedCard {
  id: string;
  cardholderName: string;
  /** Always redacted in list responses. Cleartext only via card:getDecrypted (Windows-Hello-gated). */
  number: string;
  expMonth: number;
  expYear: number;
  nickname: string | null;
  lastFour: string;
  updatedAt: number;
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}

export interface Settings {
  theme: 'system' | 'light' | 'dark';
  defaultMode: TabMode;
  adBlockEnabled: boolean;
  suspendIdleMinutes: number;
  claudeModel: string;
}

export interface AdblockStats {
  blockedThisSession: number;
}
