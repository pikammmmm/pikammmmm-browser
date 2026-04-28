# Claude Browser — Design

**Date:** 2026-04-28
**Status:** Approved

## Overview

A custom desktop web browser where the search/answer engine is **Claude** instead of Google. One address bar, three modes:

- **Web** — Claude (with its `web_search` tool) returns ranked links; clicking one loads the real webpage in the tab.
- **Image** — Brave Search API returns image results; clicking opens the source page.
- **AI** — Claude streams a markdown answer in a chat pane; no webpage involved.

Bundled browser features: encrypted password manager, encrypted saved-card autofill (Windows Hello-gated), browsing history, ad blocker.

Built on Electron + Chromium for Windows-first, with a TypeScript/React shell.

## Scope

### In scope (v1)

- Multi-tab browsing with one `WebContentsView` per tab.
- Address bar with mode toggle `[ Web | Image | AI ]`.
- Three custom panes: web results, image grid, AI chat.
- Sign in with Claude (OAuth + PKCE) using the user's Pro/Max subscription.
- Brave Search API for image mode.
- Encrypted SQLite (SQLCipher) for history, passwords, cards.
- Password autofill (silent), card autofill (Windows Hello-gated).
- Ad blocker via `@ghostery/adblocker-electron` + EasyList + EasyPrivacy + Peter Lowe's.
- HTTPS-only enforcement, hard cert-error fail.
- Code-signed installer with Electron auto-update.
- Light/dark theme honoring OS.

### Out of scope (v1)

- Mac/Linux builds (the architecture supports them; deferred).
- WebExtensions / browser extensions API.
- Sync across devices.
- Bookmarks (history covers v1; bookmarks are a follow-up).
- AI conversation history persistence (per-tab memory only).
- Real Google Pay (not achievable for a custom browser; saved-card autofill replaces it).
- Slash commands (`/img`, `/ai`) — the toggle is enough for v1.
- Auto-route by intent (mode is always explicit in v1).

## Architecture

Three layers:

1. **Main process (Node.js).** Owns app windows, tabs, the OS keychain, the local SQLite database, and all third-party API calls (Anthropic, Brave). Holds every secret. Exposes typed IPC channels.
2. **Renderer process (React + TypeScript).** The browser chrome — tab strip, address bar, mode toggle, settings, web results pane, image grid pane, AI chat pane. Speaks to main only via `contextBridge`.
3. **Per-tab `WebContentsView`.** Standard Chromium hosting the actual webpage. Preload scripts run isolated content scripts for password and autofill detection. Adblock attaches to its session's `webRequest`.

### Stack

- Electron (latest stable)
- TypeScript everywhere
- React + Vite (renderer)
- `@journeyapps/sqlcipher` (encrypted SQLite)
- `keytar` (OS keychain — Windows Credential Manager)
- `@ghostery/adblocker-electron` + EasyList + EasyPrivacy + Peter Lowe's
- `electron-builder` (Windows installer)
- `vitest` (unit + integration)
- `playwright` driving Electron (E2E)

### Performance budget

- Cold launch ≤ 2s on a typical Windows laptop.
- Steady-state RAM ≤ 300MB with one tab open.
- Lazy-mount custom mode panes; only render when the mode is active.
- Suspend background tabs after 10 min idle (drop their render process; keep TabService state in memory).
- Virtualize the tab strip and image grid.
- Pre-compile ad-block lists at install/update time, not per request.
- Use modern `WebContentsView` (lighter than legacy `BrowserView` / `<webview>`).

### Security baseline (every webContents)

- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- All IPC via typed `contextBridge` API; main whitelists channels.
- OAuth uses PKCE; refresh token stored in keychain via keytar — never in localStorage, never in a file.
- SQLCipher encryption key stored in keychain.
- Card autofill requires Windows Hello / re-auth before each fill.
- Password autofill silent (matches Chrome's UX).
- HTTPS-only outside localhost; cert errors hard-fail (no click-through).
- CSP applied to chrome UI.
- Code-signed installer + Electron auto-update for security patches.
- Errors never leak secrets to the user; raw API errors go to a debug log file.

## Components

### Main-process services

| Service | Responsibility |
|---|---|
| **AuthService** | Claude OAuth (PKCE), token refresh, keychain storage. Emits `auth:changed`. |
| **ClaudeService** | Calls Anthropic API. `webSearch(query)` (uses the `web_search` tool) and `chat(messages, stream)`. Reads token from AuthService. |
| **SearchService** | Brave Image Search API. `images(query)`. |
| **TabService** | Tab lifecycle: create, suspend, restore, close. Owns `WebContentsView` instances. |
| **HistoryService** | Append + substring search, encrypted SQLite. |
| **PasswordService** | Encrypted credential save/retrieve. Form detection in content script; encryption in main. |
| **AutofillService** | Encrypted card save/retrieve, Windows Hello gate before any card data leaves main. |
| **AdblockService** | Filter list lifecycle + request interceptor attached to every session. Weekly background list update. |
| **SettingsService** | JSON settings file (theme, default mode, ad-block on/off, suspend timer). |

### Renderer components

- `<TabStrip>` — virtualized list of tabs across the top.
- `<AddressBar>` — query/URL input + embedded `<ModeToggle>` (`Web | Image | AI`).
- `<ChromeFrame>` — wraps everything; hosts the active `WebContentsView` inside a sized container.
- `<WebResultsPane>` — Claude's web-search results as link cards. Mounted only when active mode is Web *and* the tab has a current query.
- `<ImageGridPane>` — virtualized image grid with hover preview, click-to-open-source.
- `<AIChatPane>` — markdown chat view with streaming Claude responses, code-block copy buttons, link-opens-new-tab affordance.
- `<NewTabPage>` — mode toggle + recent visits + sign-in status.
- `<SettingsPage>` — auth, passwords, cards (re-auth-gated), history, ad-block toggle/lists, debug log access.

### Per-tab content scripts (preload, isolated world)

- `password-content.ts` — login form detection, save-on-submit prompt, autofill-on-load.
- `autofill-content.ts` — checkout form detection (`autocomplete="cc-number"` etc.), autofill after re-auth.

Content scripts only do form detection and fill. They speak to main via the same `contextBridge` API as the renderer.

### On-disk layout (`%APPDATA%/claude-browser/`)

- `data.db` — SQLCipher: history, passwords, cards.
- `settings.json` — non-sensitive prefs.
- `filters/` — compiled ad-block filter lists.
- `logs/` — debug logs (no secrets).
- Keychain entries: OAuth refresh token, Brave API key, SQLCipher key.

## Data flow

### 1. First-run sign-in (Claude OAuth)

1. User clicks **Sign in with Claude** on `<NewTabPage>`.
2. Renderer → IPC `auth:start` → AuthService generates PKCE verifier + state, opens the Anthropic auth URL in the user's system browser, spins up a one-shot `http://localhost:<random-port>/callback` listener.
3. User signs in on Claude.ai → Anthropic redirects to the loopback URL with a `code`.
4. AuthService exchanges code for `access_token` + `refresh_token` (PKCE verifier proves it's us), stores the refresh token in keychain, kills the listener, focuses the app window.
5. AuthService emits `auth:changed`; renderer flips UI to signed-in.

### 2. Web mode query — e.g. "best ramen NYC"

1. User picks Web mode, types, hits Enter in `<AddressBar>`.
2. Renderer → IPC `claude:webSearch {query, tabId}` → ClaudeService.
3. ClaudeService calls Anthropic API with `tools: [{type: "web_search"}]` and a system prompt: *"Use web_search and return the top 8 results as JSON: title, url, snippet."*
4. Result list streams back to the renderer.
5. `<WebResultsPane>` renders link cards in the tab's content area; the `WebContentsView` stays hidden until a click.
6. User clicks a card → IPC `tab:navigate {tabId, url}` → TabService loads the URL in that tab's `WebContentsView` → real page renders.

### 2a. Web mode where the input is already a URL

- `<AddressBar>` detects URL syntax client-side → skips ClaudeService entirely → straight to `tab:navigate`. No Claude call wasted.

### 3. Image mode query — e.g. "sunset photos"

1. User picks Image mode, types, Enter.
2. Renderer → IPC `search:images {query}` → SearchService.
3. SearchService calls Brave `/images/search` with the key from keychain.
4. Returns `{thumbnail, source_url, page_url, width, height}[]`.
5. `<ImageGridPane>` renders the virtualized grid. Click a thumbnail → opens `page_url` in the same tab via `tab:navigate`.

### 4. AI mode query — e.g. "explain CRDTs"

1. User picks AI mode, types, Enter.
2. Renderer → IPC `claude:chat {messages, tabId}` (streaming channel) → ClaudeService → Anthropic streaming API.
3. ClaudeService forwards SSE chunks to the renderer over the same channel.
4. `<AIChatPane>` renders incrementally as markdown. Code blocks get a copy button. Links get an "open in new tab" affordance that calls `tab:create {mode: 'web', url}`.
5. Conversation history lives in renderer state for that tab. Closing the tab discards it (v1).

### 5. Loading a real webpage (autofill + ad block)

1. TabService creates `WebContentsView`, attaches AdblockService's request interceptor to its `session.webRequest`.
2. Page loads → blocked requests dropped before they hit the network.
3. DOM ready → preload runs `password-content.ts` and `autofill-content.ts` in the isolated world.
4. Login form detected → content script asks main for matching creds via `contextBridge` → PasswordService returns silently.
5. Checkout form detected → content script asks main for card → AutofillService gates on Windows Hello before responding.
6. New login submitted → content script offers "Save password?" toolbar → on accept, IPC `password:save` → encrypted to SQLite.

## Error handling

| Failure | UX |
|---|---|
| Anthropic/Brave unreachable | Mode pane shows inline retry banner. Already-loaded pages remain browsable. |
| OAuth token refresh fails | Chrome banner: "Sign in to Claude again." Modes disabled until re-auth; webpage browsing still works. |
| Anthropic rate-limited (429) | Toast: "Claude is busy. Try again in N seconds." Parses `retry-after`. |
| Brave quota exhausted | Image pane: "Image search quota reached." Other modes unaffected. |
| Page load fails (DNS / cert / connection refused) | Standard Chromium error inside `WebContentsView`. Cert errors hard-fail with no click-through. |
| Adblock filter list update fails | Keep using last good cached lists. Log silently. |
| SQLite or keychain unavailable on startup | App refuses to launch with a clear "data store error" screen — better than running with secrets exposed. |
| SSE disconnects mid-chat | AI pane shows "Connection lost — retry" inline; partial reply stays visible. |
| Form-fill content script throws | Catch in isolated world, log to main, no UI disruption. User just types manually. |

**Rule:** errors never leak secrets. The user only ever sees the human messages above; raw API errors land in a debug log file accessible from Settings.

## Testing

- **Unit (`vitest`)** on every main-process service in isolation. Mock API clients and keychain. Cover: token refresh, web-search response parsing, Brave response parsing, history search, password save/retrieve round-trip, card autofill re-auth gate, adblock matcher.
- **Integration tests** wire real services together with an in-memory SQLite and fake Anthropic/Brave servers. Validate the IPC contracts the renderer depends on — these are the seams that break on refactor.
- **E2E (`playwright` driving Electron)** — five smoke flows matching the data-flow paths above:
    1. Sign in (mock OAuth server in test mode).
    2. Type a query in Web mode → result cards render → click → page loads.
    3. Type a query in Image mode → grid renders.
    4. Type a question in AI mode → streamed answer renders.
    5. Save creds on a known login form → restart app → autofill works.
- **Manual checklist for first release:**
    - Visit a known ad-heavy page; confirm ads visibly blocked.
    - Trigger card autofill; confirm Windows Hello prompt appears before fill.
    - Idle a background tab 10+ min; confirm RAM drops as render process is freed.
    - Open `data.db` without the key; confirm contents are gibberish (encryption working).

## Pre-implementation verification

These items must be confirmed before AuthService and SearchService are built. They aren't unknowns in the design — they're checks against external systems.

- **Anthropic OAuth availability for third-party apps.** Claude Code uses an OAuth flow against Claude.ai. We must confirm this flow has a public path for new clients. If not, v1 falls back to API-key paste in Settings; OAuth becomes a follow-up.
- **Brave Search API current limits + endpoint shape.** Confirm the free tier is still 2k queries/month and that the `/images/search` response matches what SearchService expects.
