import { app, BrowserWindow, ipcMain, Menu, session, shell, dialog } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config as loadDotenv } from 'dotenv';
import { sessionPath } from '@shared/paths.js';
import { SettingsService } from './services/settings.js';
import { AuthService } from './services/auth.js';
import { ClaudeService } from './services/claude.js';
import { SearchService } from './services/search.js';
import { HistoryService } from './services/history.js';
import { PasswordService } from './services/passwords.js';
import { CardService } from './services/cards.js';
import { AdblockService } from './services/adblock.js';
import { TabsService } from './services/tabs.js';
import { BookmarksService } from './services/bookmarks.js';
import {
  importChromeBookmarks,
  importChromePasswords,
  importPasswordsCsv,
  listChromeProfiles,
} from './services/chromeImport.js';
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
    autoHideMenuBar: true,
    title: 'Pikammmmm Browser',
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

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    // Allow microphone in our chrome window so voice mode works; deny everywhere else.
    if (permission === 'media' && mainWindow && wc === mainWindow.webContents) {
      callback(true);
      return;
    }
    callback(deny(permission));
  });

  lockExternalNavigation();

  // Bootstrap services.
  const settings = new SettingsService();
  const auth = new AuthService();
  await auth.init();
  const claude = new ClaudeService(auth, settings);
  // agent tools are wired after tabsService exists below.
  const search = new SearchService();
  const history = new HistoryService();
  const passwords = new PasswordService();
  await passwords.init();
  const cards = new CardService();
  await cards.init();
  const bookmarks = new BookmarksService();
  const adblock = new AdblockService(settings);

  // Initialise DB schema before anything queries it.
  db();

  // Best-effort adblock load — failure should not block startup.
  adblock.init().catch((e: unknown) => {
    console.warn('Adblock init failed:', e);
  });

  mainWindow = await createWindow();
  tabsService = new TabsService(mainWindow, history, settings, PAGE_PRELOAD());

  claude.setAgentTools({
    openTab: (url, title) => {
      const tab = tabsService!.create({ mode: 'web', url });
      if (title) {
        // The page-title-updated event will overwrite this once the page loads,
        // but having something descriptive in the strip immediately is nicer.
        const t = tabsService!.list().find((x) => x.id === tab.id);
        if (t) t.title = title;
      }
    },
    webSearch: (query) => search.web(query),
  });

  // Restore previous session (URLs only; queries/results don't persist).
  try {
    if (existsSync(sessionPath())) {
      const raw = readFileSync(sessionPath(), 'utf8');
      const restored = JSON.parse(raw) as Array<{ url: string; mode: 'web' | 'image' | 'ai' }>;
      for (const t of restored) {
        if (t?.url && (t.mode === 'web' || t.mode === 'image' || t.mode === 'ai')) {
          tabsService.create({ mode: t.mode, url: t.url });
        }
      }
    }
  } catch {
    /* ignore corrupt session file */
  }

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
  handle('search:web', (q: string) => search.web(q));
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
  handle('tab:zoomIn', (id: string) => tabsService!.zoomBy(id, 0.1));
  handle('tab:zoomOut', (id: string) => tabsService!.zoomBy(id, -0.1));
  handle('tab:zoomReset', (id: string) => tabsService!.zoomReset(id));
  handle('tab:toggleDevTools', (id: string) => tabsService!.toggleDevTools(id));
  handle('tab:findInPage', ({ tabId, text, forward }: { tabId: string; text: string; forward?: boolean }) =>
    tabsService!.findInPage(tabId, text, forward !== false),
  );
  handle('tab:stopFindInPage', (id: string) => tabsService!.stopFindInPage(id));
  handle('tab:getPageText', (id: string) => tabsService!.getPageText(id));

  // History
  handle('history:list', (opts: any) => history.list(opts));
  handle('history:clear', () => history.clear());

  // Passwords
  handle('password:list', () => passwords.list());
  handle('password:delete', (id: string) => passwords.delete(id));
  handle('password:getForOrigin', (origin: string) => passwords.getForOrigin(origin));

  handle('password:importChrome', (profileDir?: string | null) =>
    importChromePasswords(passwords, profileDir ?? null),
  );
  handle('chrome:listProfiles', () => listChromeProfiles());
  handle('password:importCsv', async () => {
    if (!mainWindow) throw new Error('Window not ready');
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Import passwords from Chrome CSV',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { imported: 0, skipped: 0 };
    return importPasswordsCsv(passwords, r.filePaths[0]);
  });

  // ↓↓↓ END regular handle() block ↓↓↓
  // Page-preload-only channels — verify that the calling tab's URL origin
  // matches the requested origin. Otherwise any page could call
  // page:passwordsForOrigin('https://gmail.com') and read someone else's
  // saved Gmail password.
  ipcMain.handle('page:passwordsForOrigin', (event, origin: string) => {
    if (callerOrigin(event.sender.getURL()) !== origin) return [];
    return passwords.getForOriginCleartext(origin);
  });
  ipcMain.handle(
    'page:savePassword',
    (event, args: { origin: string; username: string; password: string }) => {
      if (callerOrigin(event.sender.getURL()) !== args.origin) {
        throw new Error('Origin mismatch');
      }
      passwords.save(args.origin, args.username, args.password);
    },
  );

  // Bookmarks
  handle('bookmark:list', () => bookmarks.list());
  handle('bookmark:listBar', () => bookmarks.listInBar());
  handle('bookmark:getByUrl', (url: string) => bookmarks.getByUrl(url));
  handle('bookmark:add', (args: any) => bookmarks.add(args));
  handle('bookmark:setInBar', ({ id, inBar }: { id: string; inBar: boolean }) =>
    bookmarks.setInBar(id, inBar),
  );
  handle('bookmark:delete', (id: string) => bookmarks.delete(id));
  handle('bookmark:importChrome', (profileDir?: string | null) =>
    importChromeBookmarks(bookmarks, profileDir ?? null),
  );

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
  // page:fillCard is page-side; refuse anywhere outside http(s).
  ipcMain.handle('page:fillCard', async (event, id: string) => {
    if (!callerOrigin(event.sender.getURL())) return null;
    return gatedDecrypt(id);
  });
  ipcMain.handle('page:cardsForAutofill', (event) => {
    if (!callerOrigin(event.sender.getURL())) return [];
    return cards.list();
  });

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
  tabsService.on('find', (r) => send('find:result', r));
  tabsService.on('contextSearchClaude', (text: string) =>
    send('menu:command', { command: 'searchClaude', payload: { text } }),
  );
  adblock.on('statsUpdated', (s) => send('adblock:statsUpdated', s));

  // Application menu — accelerators only; menubar hidden via autoHideMenuBar.
  Menu.setApplicationMenu(buildAppMenu(send, tabsService));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
}

function buildAppMenu(
  send: <K extends string>(channel: K, payload: unknown) => void,
  tabs: TabsService,
): Menu {
  const sendCmd = (command: string): void => send('menu:command', { command });
  const onActiveTab = (fn: (id: string) => void): void => {
    const id = tabs.getActiveId();
    if (id) fn(id);
  };
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => sendCmd('newTab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => sendCmd('closeTab') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: () => sendCmd('find') },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => sendCmd('focusAddress') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => onActiveTab((id) => tabs.reload(id)) },
        { label: 'Reload (force)', accelerator: 'F5', click: () => onActiveTab((id) => tabs.reload(id)) },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => onActiveTab((id) => tabs.zoomBy(id, 0.1)) },
        { label: 'Zoom In (alt)', accelerator: 'CmdOrCtrl+Plus', click: () => onActiveTab((id) => tabs.zoomBy(id, 0.1)) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => onActiveTab((id) => tabs.zoomBy(id, -0.1)) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => onActiveTab((id) => tabs.zoomReset(id)) },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'F12', click: () => onActiveTab((id) => tabs.toggleDevTools(id)) },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Summarize Page', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCmd('summarizePage') },
        { label: 'Translate Page (English)', accelerator: 'CmdOrCtrl+Shift+T', click: () => sendCmd('translatePage') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendCmd('settings') },
      ],
    },
  ]);
}

/** Returns the http/https origin of a webContents URL, or null for anything else. */
function callerOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    return null;
  } catch {
    return null;
  }
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
  try {
    if (tabsService) {
      writeFileSync(sessionPath(), JSON.stringify(tabsService.serialize(), null, 2));
    }
  } catch {
    /* best-effort; if it fails, next launch starts blank */
  }
  tabsService?.dispose();
  closeDb();
});

main().catch((err: Error) => {
  console.error('Fatal startup error:', err);
  app.quit();
});
