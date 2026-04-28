import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, type Rectangle } from 'electron';
import type { Tab, TabMode } from '@shared/types.js';
import type { HistoryService } from './history.js';
import type { SettingsService } from './settings.js';

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
}

export class TabsService extends EventEmitter {
  private tabs = new Map<string, TabState>();
  private activeId: string | null = null;
  private suspendInterval: NodeJS.Timeout | null = null;

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

  create(opts: { mode: TabMode; url?: string }): Tab {
    const id = randomUUID();
    const state: TabState = {
      id,
      view: null,
      mode: opts.mode,
      url: opts.url ?? '',
      title: opts.url ?? 'New tab',
      favicon: null,
      query: null,
      loading: false,
      lastActiveAt: Date.now(),
      bounds: null,
    };
    this.tabs.set(id, state);
    if (opts.url) {
      this.ensureView(state);
      state.view!.webContents.loadURL(opts.url);
    }
    return this.toPublic(state);
  }

  close(tabId: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    if (t.view) {
      this.mainWindow.contentView.removeChildView(t.view);
      t.view.webContents.close();
    }
    this.tabs.delete(tabId);
    if (this.activeId === tabId) this.activeId = null;
    this.emit('closed', tabId);
  }

  navigate(tabId: string, url: string): void {
    const t = this.tabs.get(tabId);
    if (!t) return;
    this.ensureView(t);
    t.url = url;
    t.loading = true;
    t.view!.webContents.loadURL(url);
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
    if (t.url) this.ensureView(t);
    if (t.view) {
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
      this.history.log(t.url, title);
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
    wc.setWindowOpenHandler(({ url }) => {
      this.create({ mode: 'web', url });
      return { action: 'deny' };
    });
    // Hard-fail on cert errors (no click-through).
    wc.on('certificate-error', (e) => {
      e.preventDefault();
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
    };
  }
}
