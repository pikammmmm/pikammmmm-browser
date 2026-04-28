# Claude Browser

A desktop web browser where the search/answer engine is **Claude** instead of Google. Three modes share one address bar:

- **Web** — Claude (with its `web_search` tool) returns ranked links; clicking one loads the real webpage in the tab.
- **Image** — Brave Search API returns image results; clicking opens the source page.
- **AI** — Claude streams a markdown answer in a chat pane.

Plus the basics: encrypted password manager, encrypted saved-card autofill, browsing history, ad blocker.

Built on Electron + Chromium. Windows-first.

## Quickstart (dev)

```bash
npm install
npm run dev
```

`npm install` will compile two native modules (`better-sqlite3`, `keytar`). On Windows you'll need either:
- Visual Studio Build Tools with the "Desktop development with C++" workload, or
- the prebuilt binaries that npm pulls automatically (usually fine for current Node + Electron LTS).

If install fails or you see "the specified procedure could not be found" at first launch, run:

```bash
npm run rebuild
```

## Configuration

Copy `.env.example` to `.env` and fill in what you have:

```
CLAUDE_OAUTH_CLIENT_ID=        # blank → Sign in with Claude is disabled, use API key instead
BRAVE_API_KEY=                 # optional; can also be set in Settings UI
CLAUDE_MODEL=claude-opus-4-7   # any current Anthropic model id
```

If you don't have OAuth set up yet, just skip it: open the app → Settings → paste your `sk-ant-...` API key. Get one at <https://console.anthropic.com/>.

For image mode: get a free Brave Search API key at <https://api.search.brave.com/> (free tier is 2000 queries/month). Paste it in Settings.

## Build a Windows installer

```bash
npm run package
```

Output lands in `dist/`. The installer is unsigned — for distribution you'd add a code-signing certificate to `electron-builder.yml`.

## Tests

```bash
npm test
```

Covers the crypto round-trip, web-search response parsing, and settings persistence. The full E2E plan (Playwright driving Electron through five smoke flows) is documented in the spec but not yet wired up — that's the natural next addition.

## Architecture

See `docs/superpowers/specs/2026-04-28-claude-browser-design.md` for the full design. Quick mental model:

- **Main process** (Node.js) holds every secret, owns tabs, and makes all third-party API calls. Services live in `src/main/services/`.
- **Renderer process** (React + TypeScript) is the browser chrome — tab strip, address bar, mode toggle, settings, and the three custom mode panes.
- **Per-tab `WebContentsView`** hosts the actual webpage. Its preload (`src/preload/pagePreload.ts`) does password and card autofill detection in an isolated world.

## v1 limitations to be aware of

These are intentional and documented; v1.1+ would close them:

- **OAuth client ID is BYO.** Anthropic's third-party OAuth setup needs to be confirmed available; until then, the API-key paste flow in Settings is the supported path.
- **Card autofill re-auth uses a confirmation dialog**, not real Windows Hello. The architecture has the gate in place — swapping in a native addon (`Windows.Security.Credentials.UI`) is a one-file change in `src/main/services/cards.ts`.
- **Encryption.** Sensitive fields (passwords, card numbers) are AES-GCM encrypted with a key in OS keychain. The SQLite database itself is plain — switching to SQLCipher (`@journeyapps/sqlcipher`) is a drop-in if you need full-DB encryption.
- **No bookmarks or sync** in v1. History and browsing work; bookmarks UI is the obvious next add.
- **AI conversation history doesn't persist** between tabs/sessions. Each tab keeps its own thread until you close it.
- **Single-account password autofill.** If you have multiple saved logins for one origin, the first wins. A picker UI is the v1.1 add.

## Project layout

```
src/
  shared/        # types + IPC channel definitions, used by main and renderer
  main/          # Electron main process
    services/    # Auth, Claude, Search, Tabs, History, Passwords, Cards, Adblock, Settings
    db.ts        # better-sqlite3 setup + schema
    crypto.ts    # AES-GCM helpers
    secrets.ts   # OS keychain wrapper
    index.ts     # entry — boots services, registers IPC, manages window
  preload/
    chromePreload.ts   # contextBridge for the React shell
    pagePreload.ts     # contextBridge for tab webContents + inlined password/card autofill
  renderer/      # React app — chrome UI + mode panes + settings
docs/superpowers/specs/   # design doc
tests/          # vitest
```

## License

UNLICENSED — personal project.
