import { app, BrowserWindow, ipcMain, session, shell, dialog } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { SettingsService } from './services/settings.js';
import { AuthService } from './services/auth.js';
import { ClaudeService } from './services/claude.js';
import { SearchService } from './services/search.js';
import { HistoryService } from './services/history.js';
import { PasswordService } from './services/passwords.js';
import { CardService } from './services/cards.js';
import { AdblockService } from './services/adblock.js';
import { TabsService } from './services/tabs.js';
import { db, closeDb } from './db.js';

// best-effort .env load (dev only)
try {
  loadDotenv();
} catch {
  /* ignore */
}

let mainWindow: BrowserWindow | null = null;
let tabsService: TabsService | null = null;

const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;
const appRoot = (): string => app.getAppPath();
const CHROME_PRELOAD = (): string => join(appRoot(), 'out/preload/chromePreload.js');
const PAGE_PRELOAD = (): string => join(appRoot(), 'out/preload/pagePreload.js');
const RENDERER_INDEX = (): string => join(appRoot(), 'out/renderer/index.html');

async function createWindow(): Promise<BrowserWindow> {
  const iconPath = join(appRoot(), 'build/icon.ico');
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: '#1a1a1a',
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: CHROME_PRELOAD(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  if (RENDERER_DEV_URL) {
    await win.loadURL(RENDERER_DEV_URL);
  } else {
    await win.loadFile(RENDERER_INDEX());
  }

  return win;
}

function lockExternalNavigation(): void {
  // Renderer is loaded from disk/dev-server; never let it navigate elsewhere.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      const allowed =
        url.startsWith(RENDERER_DEV_URL ?? '') ||
        url.startsWith('file://') ||
        url.startsWith('http://') ||
        url.startsWith('https://');
      if (!allowed) {
        e.preventDefault();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  });
}

function deny(perm: string): boolean {
  // Block everything by default; opt in to a small whitelist below.
  void perm;
  return false;
}

async function main(): Promise<void> {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  await app.whenReady();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(deny(permission));
  });

  lockExternalNavigation();

  // Bootstrap services.
  const settings = new SettingsService();
  const auth = new AuthService();
  await auth.init();
  const claude = new ClaudeService(auth, settings);
  const search = new SearchService();
  const history = new HistoryService();
  const passwords = new PasswordService();
  await passwords.init();
  const cards = new CardService();
  await cards.init();
  const adblock = new AdblockService(settings);

  // Initialise DB schema before anything queries it.
  db();

  // Best-effort adblock load — failure should not block startup.
  adblock.init().catch((e: unknown) => {
    console.warn('Adblock init failed:', e);
  });

  mainWindow = await createWindow();
  tabsService = new TabsService(mainWindow, history, settings, PAGE_PRELOAD());

  // ---- IPC handlers ----
  const handle = <K extends string>(channel: K, fn: (...args: any[]) => any): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(...args));
  };

  // Auth
  handle('auth:start', () => auth.startOAuth());
  handle('auth:signOut', () => auth.signOut());
  handle('auth:getState', () => auth.getState());
  handle('auth:oauthConfigured', () => auth.oauthConfigured());
  handle('auth:setApiKey', (key: string) => auth.setApiKey(key));

  // Claude
  handle('claude:webSearch', (q: string) => claude.webSearch(q));
  handle('claude:chatStart', ({ messages }: { tabId: string; messages: any[] }) =>
    claude.chatStart(messages),
  );
  handle('claude:chatCancel', (id: string) => claude.chatCancel(id));

  // Search
  handle('search:images', (q: string) => search.images(q));
  handle('search:setSearchKey', (k: string) => search.setSearchKey(k));

  // Tabs
  handle('tab:create', (opts: any) => tabsService!.create(opts));
  handle('tab:close', (id: string) => tabsService!.close(id));
  handle('tab:list', () => tabsService!.list());
  handle('tab:navigate', ({ tabId, url }: { tabId: string; url: string }) =>
    tabsService!.navigate(tabId, url),
  );
  handle('tab:setMode', ({ tabId, mode, query }: { tabId: string; mode: any; query?: any }) =>
    tabsService!.setMode(tabId, mode, query ?? null),
  );
  handle('tab:setBounds', ({ tabId, bounds }: { tabId: string; bounds: any }) =>
    tabsService!.setBounds(tabId, bounds),
  );
  handle('tab:show', (id: string) => tabsService!.show(id));
  handle('tab:hide', (id: string) => tabsService!.hide(id));
  handle('tab:goBack', (id: string) => tabsService!.goBack(id));
  handle('tab:goForward', (id: string) => tabsService!.goForward(id));
  handle('tab:reload', (id: string) => tabsService!.reload(id));

  // History
  handle('history:list', (opts: any) => history.list(opts));
  handle('history:clear', () => history.clear());

  // Passwords
  handle('password:list', () => passwords.list());
  handle('password:save', ({ origin, username, password }: any) =>
    passwords.save(origin, username, password),
  );
  handle('password:delete', (id: string) => passwords.delete(id));
  handle('password:getForOrigin', (origin: string) => passwords.getForOrigin(origin));

  // Page-preload-only channels (cleartext password lookup, card fill).
  handle('page:passwordsForOrigin', (origin: string) => passwords.getForOriginCleartext(origin));

  // Cards
  handle('card:list', () => cards.list());
  handle('card:save', (card: any) => cards.save(card));
  handle('card:delete', (id: string) => cards.delete(id));
  const gatedDecrypt = async (id: string): Promise<ReturnType<typeof cards.getDecrypted>> => {
    const ok = await confirmCardAccess();
    if (!ok) return null;
    return cards.getDecrypted(id);
  };
  handle('card:getDecrypted', (id: string) => gatedDecrypt(id));
  handle('page:fillCard', (id: string) => gatedDecrypt(id));
  handle('page:cardsForAutofill', () => cards.list());

  // Settings
  handle('settings:get', () => settings.get());
  handle('settings:update', (patch: any) => {
    const next = settings.update(patch);
    if ('adBlockEnabled' in patch) {
      void adblock.init();
    }
    return next;
  });

  // Adblock
  handle('adblock:reload', () => adblock.reload());
  handle('adblock:stats', () => adblock.stats());

  // ---- main → renderer event forwarding ----
  const send = <K extends string>(channel: K, payload: unknown): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  };
  auth.on('changed', (s) => send('auth:changed', s));
  claude.on('chatChunk', (p) => send('claude:chatChunk', p));
  claude.on('chatDone', (p) => send('claude:chatDone', p));
  claude.on('chatError', (p) => send('claude:chatError', p));
  tabsService.on('updated', (t) => send('tab:updated', t));
  tabsService.on('closed', (id) => send('tab:closed', id));
  adblock.on('statsUpdated', (s) => send('adblock:statsUpdated', s));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

async function confirmCardAccess(): Promise<boolean> {
  if (!mainWindow) return false;
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Confirm autofill',
    message: 'Use a saved card?',
    detail:
      'Claude Browser will autofill card details on this page. Confirm to continue.\n\n' +
      '(v1 placeholder for Windows Hello — v1.1 will use the OS biometric prompt.)',
  });
  return r.response === 0;
}

app.on('before-quit', () => {
  tabsService?.dispose();
  closeDb();
});

main().catch((err: Error) => {
  console.error('Fatal startup error:', err);
  app.quit();
});
