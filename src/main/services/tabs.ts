import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, Menu, WebContentsView, clipboard, session, type Rectangle } from 'electron';
import type { Tab, TabMode } from '@shared/types.js';
import type { HistoryService } from './history.js';
import type { SettingsService } from './settings.js';

/** http/https + about:blank only. Blocks javascript:, file:, data:, etc. */
function safeNavUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return url;
    if (u.protocol === 'about:' && (u.pathname === '' || u.pathname === 'blank')) return 'about:blank';
    return null;
  } catch {
    return null;
  }
}

interface TabState {
  id: string;
  view: WebContentsView | null;
  mode: TabMode;
  url: string;
  title: string;
  favicon: string | null;
  query: string | null;
  loading: boolean;
  lastActiveAt: number;
  bounds: Rectangle | null;
  pinned: boolean;
  muted: boolean;
  audible: boolean;
  incognito: boolean;
}

const INCOGNITO_PARTITION = 'incognito-volatile'; // no `persist:` prefix → in-memory

interface ClosedTabSnapshot {
  url: string;
  mode: TabMode;
  pinned: boolean;
}

export class TabsService extends EventEmitter {
  private tabs: Map<string, TabState> = new Map();
  private activeId: string | null = null;
  private suspendInterval: NodeJS.Timeout | null = null;
  private closeStack: ClosedTabSnapshot[] = [];

  constructor(
    private mainWindow: BrowserWindow,
    private history: HistoryService,
    private settings: SettingsService,
    private pagePreloadPath: string,
  ) {
    super();
    this.suspendInterval = setInterval(() => this.suspendIdleTabs(), 60_000);
  }

  dispose(): void {
    if (this.suspendInterval) clearInterval(this.suspendInterval);
    for (const t of this.tabs.values()) {
      if (t.view) t.view.webContents.close();
    }
    this.tabs.clear();
  }

  list(): Tab[] {
    return [...this.tabs.values()].map((t) => this.toPublic(t));
  }

  /** Snapshot of currently-open tabs suitable for session restore. */
  serialize(): Array<{ url: string; mode: TabMode }> {
    return [...this.tabs.values()]
      .filter((t) => !!t.url && t.mode === 'web')
      .map((t) => ({ url: t.url, mode: t.mode }));
  }

  create(opts: { mode: TabMode; url?: string; incognito?: boolean }): Tab {
    const id = randomUUID();
    const state: TabState = {
      id,
      view: null,
      mode: opts.mode,
      url: opts.url ?? '',
      title: opts.url ?? (opts.incognito ? 'Incognito' : 'New tab'),
      favicon: null,
      query: null,
      loading: false,
      lastActiveAt: Date.now(),
      bounds: null,
      pinned: false,
      muted: false,
      audible: false,
      incognito: !!opts.incognito,
    };
    this.tabs.set(id, state);
    if (opts.url) {
      const safe = safeNavUrl(opts.url);
      if (safe) {
        this.ensureView(state);
        state.view!.webContents.loadURL(safe);
        state.url = safe;
      } else {
        state.url = '';
      }
    }
    return this.toPublic(state);
  }

  close(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    // Push to undo stack only if there's a real URL — empty new-tab pages
    // aren't worth restoring.
    if (t.url) {
      this.closeStack.push({ url: t.url, mode: t.mode, pinned: t.pinned });
      if (this.closeStack.length > 20) this.closeStack.shift();
    }
    if (t.view) {
      this.mainWindow.contentView.removeChildView(t.view);
      t.view.webContents.close();
    }
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = null;
    this.emit('closed', tabId);
  }

  closeOthers(keepId: string): void {
    for (const id of [...this.tabs.keys()]) {
      const t = this.tabs.get(id);
      if (id !== keepId && t && !t.pinned) this.close(id);
    }
  }

  closeToRight(tabId: string): void {
    const ids = [...this.tabs.keys()];
    const idx = ids.indexOf(tabId);
    if (idx < 0) return;
    for (const id of ids.slice(idx + 1)) {
      const t = this.tabs.get(id);
      if (t && !t.pinned) this.close(id);
    }
  }

  undoClose(): Tab | null {
    const last = this.closeStack.pop();
    if (!last) return null;
    return this.create({ mode: last.mode, url: last.url });
  }

  setPinned(tabId: string, pinned: boolean): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.pinned = pinned;
    this.emitUpdate(t);
  }

  setMuted(tabId: string, muted: boolean): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.muted = muted;
    if (t.view) t.view.webContents.setAudioMuted(muted);
    this.emitUpdate(t);
  }

  navigate(tabId: string, url: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    const safe = safeNavUrl(url);
    if (!safe) {
      // Refuse silently; never load javascript:/file:/data: URLs.
      return;
    }
    this.ensureView(t);
    t.url = safe;
    t.loading = true;
    t.view!.webContents.loadURL(safe);
    this.emitUpdate(t);
  }

  setMode(tabId: string, mode: TabMode, query: string | null = null): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.mode = mode;
    t.query = query;
    t.lastActiveAt = Date.now();
    this.emitUpdate(t);
  }

  /** Reorder tabs by moving `fromId` to the position currently held by `toId`. */
  reorder(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const entries = [...this.tabs.entries()];
    const fromIdx = entries.findIndex(([id]) => id === fromId);
    const toIdx = entries.findIndex(([id]) => id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = entries.splice(fromIdx, 1);
    entries.splice(toIdx, 0, moved!);
    this.tabs = new Map(entries);
  }

  setBounds(tabId: string, bounds: Rectangle): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.bounds = bounds;
    if (t.view && this.activeId === tabId) t.view.setBounds(bounds);
  }

  show(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    for (const other of this.tabs.values()) {
      if (other.id !== tabId && other.view) {
        this.mainWindow.contentView.removeChildView(other.view);
      }
    }
    const restoringFromSuspend = !t.view && !!t.url;
    if (t.url) this.ensureView(t);
    if (t.view) {
      // If we just rebuilt the view after a suspend, the new webContents is
      // empty. Reload the saved URL so the user gets the page back instead
      // of about:blank.
      if (restoringFromSuspend) {
        t.loading = true;
        t.view.webContents.loadURL(t.url);
        this.emitUpdate(t);
      }
      this.mainWindow.contentView.addChildView(t.view);
      if (t.bounds) t.view.setBounds(t.bounds);
    }
    this.activeId = tabId;
    t.lastActiveAt = Date.now();
  }

  hide(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t || !t.view) return;
    this.mainWindow.contentView.removeChildView(t.view);
    if (this.activeId === tabId) this.activeId = null;
  }

  goBack(tabId: string): void {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.navigationHistory.goBack();
  }

  goForward(tabId: string): void {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.navigationHistory.goForward();
  }

  reload(tabId: string): void {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.reload();
  }

  zoomBy(tabId: string, delta: number): number {
    const t = this.tabs.get(tabId);
    if (!t?.view) return 1;
    const next = Math.max(0.25, Math.min(5, t.view.webContents.getZoomFactor() + delta));
    t.view.webContents.setZoomFactor(next);
    return next;
  }

  zoomReset(tabId: string): number {
    const t = this.tabs.get(tabId);
    if (!t?.view) return 1;
    t.view.webContents.setZoomFactor(1);
    return 1;
  }

  toggleDevTools(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t?.view) return;
    if (t.view.webContents.isDevToolsOpened()) t.view.webContents.closeDevTools();
    else t.view.webContents.openDevTools({ mode: 'detach' });
  }

  print(tabId: string): void {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.print({ silent: false });
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /** Set up find-in-page + bubble results back via the emitter. */
  findInPage(tabId: string, text: string, forward = true): void {
    const t = this.tabs.get(tabId);
    if (!t?.view || !text) return;
    const wc = t.view.webContents;
    if (!this._findHooked.has(tabId)) {
      this._findHooked.add(tabId);
      wc.on('found-in-page', (_e, result) => {
        this.emit('find', {
          tabId,
          activeMatch: result.activeMatchOrdinal,
          matches: result.matches,
        });
      });
    }
    wc.findInPage(text, { forward, findNext: false });
  }

  stopFindInPage(tabId: string): void {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.stopFindInPage('clearSelection');
  }

  async getPageText(tabId: string): Promise<string> {
    const t = this.tabs.get(tabId);
    if (!t?.view) return '';
    const text = (await t.view.webContents.executeJavaScript(
      'document.body.innerText',
    )) as unknown;
    return typeof text === 'string' ? text.slice(0, 50_000) : '';
  }

  private _findHooked = new Set<string>();

  private ensureView(t: TabState): void {
    if (t.view) return;
    const view = new WebContentsView({
      webPreferences: {
        preload: this.pagePreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // Incognito tabs use an in-memory partition (no `persist:` prefix);
        // history, cookies, and storage are isolated and discarded on quit.
        partition: t.incognito ? INCOGNITO_PARTITION : undefined,
      },
    });
    t.view = view;

    const wc = view.webContents;
    wc.on('did-start-loading', () => {
      t.loading = true;
      this.emitUpdate(t);
    });
    wc.on('did-stop-loading', () => {
      t.loading = false;
      this.emitUpdate(t);
    });
    wc.on('page-title-updated', (_e, title) => {
      t.title = title;
      // Skip history logging for incognito tabs.
      if (!t.incognito) this.history.log(t.url, title);
      this.emitUpdate(t);
    });
    wc.on('did-navigate', (_e, url) => {
      t.url = url;
      this.emitUpdate(t);
    });
    wc.on('did-navigate-in-page', (_e, url) => {
      t.url = url;
      this.emitUpdate(t);
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      t.favicon = favicons[0] ?? null;
      this.emitUpdate(t);
    });
    wc.on('audio-state-changed', (e) => {
      t.audible = e.audible;
      this.emitUpdate(t);
    });
    wc.setWindowOpenHandler(({ url }) => {
      const safe = safeNavUrl(url);
      if (safe) this.create({ mode: 'web', url: safe });
      return { action: 'deny' };
    });
    // Cert errors hard-fail by default (no listener = Electron rejects).
    // Calling preventDefault without callback(true) is undefined behaviour.
    wc.on('context-menu', (_e, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (params.linkURL) {
        items.push({
          label: 'Open Link in New Tab',
          click: () => {
            const safe = safeNavUrl(params.linkURL);
            if (safe) this.create({ mode: 'web', url: safe });
          },
        });
        items.push({
          label: 'Copy Link Address',
          click: () => clipboard.writeText(params.linkURL),
        });
        items.push({ type: 'separator' });
      }
      if (params.mediaType === 'image' && params.srcURL) {
        items.push({
          label: 'Open Image in New Tab',
          click: () => {
            const safe = safeNavUrl(params.srcURL);
            if (safe) this.create({ mode: 'web', url: safe });
          },
        });
        items.push({
          label: 'Copy Image Address',
          click: () => clipboard.writeText(params.srcURL),
        });
        items.push({ type: 'separator' });
      }
      if (params.selectionText) {
        const snippet = params.selectionText.slice(0, 40).trim();
        items.push({
          label: `Ask Claude about "${snippet}${params.selectionText.length > 40 ? '…' : ''}"`,
          click: () => this.emit('contextSearchClaude', params.selectionText),
        });
        items.push({ role: 'copy' });
        items.push({ type: 'separator' });
      }
      if (params.isEditable) {
        items.push({ role: 'cut' });
        items.push({ role: 'copy' });
        items.push({ role: 'paste' });
        items.push({ type: 'separator' });
      }
      items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      items.push({ label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      items.push({ label: 'Reload', click: () => wc.reload() });
      items.push({ type: 'separator' });
      items.push({ label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) });
      Menu.buildFromTemplate(items).popup();
    });
  }

  private suspendIdleTabs(): void {
    const idleMs = this.settings.get().suspendIdleMinutes * 60_000;
    const now = Date.now();
    for (const t of this.tabs.values()) {
      if (t.id === this.activeId) continue;
      if (!t.view) continue;
      if (now - t.lastActiveAt < idleMs) continue;
      this.mainWindow.contentView.removeChildView(t.view);
      t.view.webContents.close();
      t.view = null;
    }
  }

  private emitUpdate(t: TabState): void {
    this.emit('updated', this.toPublic(t));
  }

  private toPublic(t: TabState): Tab {
    return {
      id: t.id,
      mode: t.mode,
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      query: t.query,
      loading: t.loading,
      canGoBack: t.view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: t.view?.webContents.navigationHistory.canGoForward() ?? false,
      pinned: t.pinned,
      muted: t.muted,
      audible: t.audible,
      incognito: t.incognito,
    };
  }
}

void session; // silence unused-import lint when partition isn't referenced inline
