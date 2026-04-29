"use strict";
const electron = require("electron");
const node_path = require("node:path");
const node_fs = require("node:fs");
const dotenv = require("dotenv");
const node_events = require("node:events");
const node_crypto = require("node:crypto");
const node_http = require("node:http");
const keytar = require("keytar");
const Database = require("better-sqlite3");
const adblockerElectron = require("@ghostery/adblocker-electron");
const node_child_process = require("node:child_process");
const node_util = require("node:util");
const node_os = require("node:os");
function userDataDir() {
  return electron.app.getPath("userData");
}
function ensureDir(p) {
  node_fs.mkdirSync(p, { recursive: true });
  return p;
}
function dbPath() {
  return node_path.join(userDataDir(), "data.db");
}
function settingsPath() {
  return node_path.join(userDataDir(), "settings.json");
}
function sessionPath() {
  return node_path.join(userDataDir(), "session.json");
}
function filtersDir() {
  return ensureDir(node_path.join(userDataDir(), "filters"));
}
const KEYCHAIN_SERVICE = "claude-browser";
const KEYCHAIN_KEYS = {
  oauthRefresh: "oauth-refresh-token",
  oauthAccess: "oauth-access-token",
  apiKey: "anthropic-api-key",
  searchKey: "tavily-api-key",
  dbKey: "db-encryption-key"
};
const DEFAULTS = {
  theme: "system",
  defaultMode: "web",
  adBlockEnabled: true,
  suspendIdleMinutes: 10,
  claudeModel: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6"
};
let cache = null;
class SettingsService {
  get() {
    if (cache) return cache;
    const path = settingsPath();
    if (!node_fs.existsSync(path)) {
      cache = { ...DEFAULTS };
      node_fs.writeFileSync(path, JSON.stringify(cache, null, 2));
      return cache;
    }
    try {
      const raw = JSON.parse(node_fs.readFileSync(path, "utf8"));
      if (raw.claudeModel === "claude-opus-4-7") {
        delete raw.claudeModel;
      }
      cache = { ...DEFAULTS, ...raw };
    } catch {
      cache = { ...DEFAULTS };
    }
    return cache;
  }
  update(patch) {
    const next = { ...this.get(), ...patch };
    cache = next;
    node_fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
    return next;
  }
}
async function getSecret(name) {
  return keytar.getPassword(KEYCHAIN_SERVICE, name);
}
async function setSecret(name, value) {
  await keytar.setPassword(KEYCHAIN_SERVICE, name, value);
}
async function deleteSecret(name) {
  await keytar.deletePassword(KEYCHAIN_SERVICE, name);
}
function readOAuthConfig() {
  const clientId = process.env.CLAUDE_OAUTH_CLIENT_ID;
  const authUrl = process.env.CLAUDE_OAUTH_AUTH_URL;
  const tokenUrl = process.env.CLAUDE_OAUTH_TOKEN_URL;
  if (!clientId || !authUrl || !tokenUrl) return null;
  return { clientId, authUrl, tokenUrl };
}
function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
class AuthService extends node_events.EventEmitter {
  state = { signedIn: false, method: "none" };
  async init() {
    const refresh = await getSecret(KEYCHAIN_KEYS.oauthRefresh);
    const apiKey = await getSecret(KEYCHAIN_KEYS.apiKey);
    if (refresh) this.state = { signedIn: true, method: "oauth" };
    else if (apiKey) this.state = { signedIn: true, method: "apiKey" };
    else this.state = { signedIn: false, method: "none" };
  }
  getState() {
    return this.state;
  }
  oauthConfigured() {
    return readOAuthConfig() !== null;
  }
  async signOut() {
    await deleteSecret(KEYCHAIN_KEYS.oauthRefresh);
    await deleteSecret(KEYCHAIN_KEYS.oauthAccess);
    await deleteSecret(KEYCHAIN_KEYS.apiKey);
    this.setState({ signedIn: false, method: "none" });
  }
  async setApiKey(key) {
    if (!key.startsWith("sk-ant-")) {
      throw new Error("That doesn't look like an Anthropic API key (expected sk-ant-...).");
    }
    await setSecret(KEYCHAIN_KEYS.apiKey, key);
    this.setState({ signedIn: true, method: "apiKey" });
    return this.state;
  }
  /**
   * Bearer token used by ClaudeService. Prefers OAuth access token, falls back to API key.
   * Returns { kind, value } so the caller can pick the right HTTP header.
   */
  async getCredential() {
    const access = await getSecret(KEYCHAIN_KEYS.oauthAccess);
    if (access) return { kind: "bearer", value: access };
    const key = await getSecret(KEYCHAIN_KEYS.apiKey);
    if (key) return { kind: "apiKey", value: key };
    return null;
  }
  async startOAuth() {
    const cfg = readOAuthConfig();
    if (!cfg) {
      throw new Error(
        "Claude OAuth is not configured. Set CLAUDE_OAUTH_* env vars, or paste an API key in Settings."
      );
    }
    const verifier = base64url(node_crypto.randomBytes(32));
    const challenge = base64url(node_crypto.createHash("sha256").update(verifier).digest());
    const stateParam = base64url(node_crypto.randomBytes(16));
    const { port, redirectUri, codePromise } = await this.startCallbackServer(stateParam);
    const url = new URL(cfg.authUrl);
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "org:create_api_key user:profile");
    url.searchParams.set("state", stateParam);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    void electron.shell.openExternal(url.toString());
    const code = await codePromise;
    await this.exchangeCode(cfg, code, verifier, redirectUri);
  }
  startCallbackServer(expectedState) {
    return new Promise((resolveOuter, rejectOuter) => {
      let resolveCode;
      let rejectCode;
      const codePromise = new Promise((res, rej) => {
        resolveCode = res;
        rejectCode = rej;
      });
      const server = node_http.createServer((req, res) => {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        if (reqUrl.pathname !== "/callback") {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const code = reqUrl.searchParams.get("code");
        const state = reqUrl.searchParams.get("state");
        const error = reqUrl.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end(`<h1>Sign-in cancelled</h1><p>${error}</p>You can close this tab.`);
          rejectCode(new Error(error));
        } else if (state !== expectedState || !code) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end("<h1>Bad state</h1>You can close this tab.");
          rejectCode(new Error("OAuth state mismatch"));
        } else {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<h1>You can close this tab.</h1>Return to Claude Browser.");
          resolveCode(code);
        }
        setTimeout(() => server.close(), 100);
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "string" || !addr) {
          rejectOuter(new Error("failed to bind callback server"));
          return;
        }
        const port = addr.port;
        resolveOuter({
          port,
          redirectUri: `http://127.0.0.1:${port}/callback`,
          codePromise
        });
      });
      server.on("error", rejectOuter);
    });
  }
  async exchangeCode(cfg, code, verifier, redirectUri) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: verifier
    });
    const r = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    if (!r.ok) throw new Error(`OAuth token exchange failed: ${r.status}`);
    const j = await r.json();
    await setSecret(KEYCHAIN_KEYS.oauthAccess, j.access_token);
    if (j.refresh_token) await setSecret(KEYCHAIN_KEYS.oauthRefresh, j.refresh_token);
    this.setState({ signedIn: true, method: "oauth" });
  }
  setState(s) {
    this.state = s;
    this.emit("changed", s);
  }
}
const ANTHROPIC_VERSION = "2023-06-01";
class ClaudeService extends node_events.EventEmitter {
  constructor(auth, settings) {
    super();
    this.auth = auth;
    this.settings = settings;
  }
  streams = /* @__PURE__ */ new Map();
  agentTools = null;
  setAgentTools(tools) {
    this.agentTools = tools;
  }
  apiUrl() {
    return process.env.ANTHROPIC_API_URL ?? "https://api.anthropic.com";
  }
  async authHeaders() {
    const cred = await this.auth.getCredential();
    if (!cred) throw new Error("Not signed in.");
    if (cred.kind === "bearer") return { authorization: `Bearer ${cred.value}` };
    return { "x-api-key": cred.value };
  }
  /**
   * Web search via the Anthropic API's web_search tool. Asks Claude to use the tool
   * and emit a JSON list of {title, url, snippet} as the final message.
   */
  async webSearch(query) {
    const auth = await this.authHeaders();
    const r = await fetch(`${this.apiUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        ...auth
      },
      body: JSON.stringify({
        model: this.settings.get().claudeModel,
        max_tokens: 4096,
        system: 'You are a search engine. Use the web_search tool, then return ONLY a JSON array of the top 20 most relevant results in the form [{"title":"...","url":"...","snippet":"..."}]. No prose, no preamble. JSON only.',
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }],
        messages: [{ role: "user", content: query }]
      })
    });
    if (!r.ok) throw new Error(`Claude web search failed: ${r.status} ${await r.text().catch(() => "")}`);
    const j = await r.json();
    const lastText = [...j.content].reverse().find((b) => b.type === "text");
    if (!lastText || lastText.type !== "text") {
      return this.extractFallbackResults(j);
    }
    return this.parseJsonArray(lastText.text) ?? this.extractFallbackResults(j);
  }
  parseJsonArray(text) {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      const arr = JSON.parse(match[0]);
      if (!Array.isArray(arr)) return null;
      return arr.filter(
        (x) => typeof x === "object" && x !== null && typeof x.title === "string" && typeof x.url === "string"
      ).map((x) => ({
        title: x.title,
        url: x.url,
        snippet: typeof x.snippet === "string" ? x.snippet : ""
      }));
    } catch {
      return null;
    }
  }
  extractFallbackResults(j) {
    const out = [];
    for (const block of j.content) {
      if (block.type === "web_search_tool_result") {
        for (const r of block.content) {
          out.push({ title: r.title, url: r.url, snippet: "" });
        }
      }
    }
    return out.slice(0, 20);
  }
  /**
   * Streaming chat for AI mode. Returns a streamId; chunks are emitted as
   * 'chatChunk' events on this service.
   *
   * If agent tools are wired up, Claude can call open_tab() and web_search()
   * to act on the user's behalf — making "open me some news articles" actually
   * open them.
   */
  async chatStart(messages) {
    const streamId = node_crypto.randomUUID();
    const ac = new AbortController();
    this.streams.set(streamId, ac);
    const runner = this.agentTools ? this.runAgentStream(streamId, messages, ac.signal) : this.runChatStream(streamId, messages, ac.signal);
    void runner.catch((err) => {
      this.emit("chatError", { streamId, error: err.message });
      this.streams.delete(streamId);
    });
    return streamId;
  }
  chatCancel(streamId) {
    const ac = this.streams.get(streamId);
    if (ac) {
      ac.abort();
      this.streams.delete(streamId);
    }
  }
  async runChatStream(streamId, messages, signal) {
    const auth = await this.authHeaders();
    const r = await fetch(`${this.apiUrl()}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        accept: "text/event-stream",
        ...auth
      },
      body: JSON.stringify({
        model: this.settings.get().claudeModel,
        max_tokens: 4096,
        stream: true,
        messages
      }),
      signal
    });
    if (!r.ok || !r.body) throw new Error(`Claude chat failed: ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
            this.emit("chatChunk", { streamId, delta: evt.delta.text });
          }
        } catch {
        }
      }
    }
    this.emit("chatDone", { streamId });
    this.streams.delete(streamId);
  }
  /**
   * Agent loop. Uses the messages API non-streaming for simpler tool wiring;
   * emits chunks per turn so the chat still feels live. Up to 10 tool-use
   * iterations to prevent runaway.
   */
  async runAgentStream(streamId, messages, signal) {
    const tools = this.agentTools;
    const auth = await this.authHeaders();
    const toolDefs = [
      {
        name: "open_tab",
        description: "Open a URL in a new browser tab. Use this when the user asks you to open / pull up / navigate to something — actually do it, don't just suggest links.",
        input_schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full https URL" },
            title: { type: "string", description: "Optional human-readable title" }
          },
          required: ["url"]
        }
      },
      {
        name: "web_search",
        description: "Search the live web for current information. Use whenever you need facts you can't reliably know (recent news, prices, schedules, etc).",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" }
          },
          required: ["query"]
        }
      }
    ];
    const working = messages.map((m) => ({ role: m.role, content: m.content }));
    for (let iter = 0; iter < 10; iter++) {
      if (signal.aborted) return;
      const r = await fetch(`${this.apiUrl()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          ...auth
        },
        body: JSON.stringify({
          model: this.settings.get().claudeModel,
          max_tokens: 4096,
          system: "You are Claude, integrated into a desktop browser. When the user asks you to open / show / pull up content, use the open_tab tool to do it for real. When you need current information, use web_search. Keep replies concise.",
          tools: toolDefs,
          messages: working
        }),
        signal
      });
      if (!r.ok) {
        throw new Error(`Claude agent failed: ${r.status} ${await r.text().catch(() => "")}`);
      }
      const j = await r.json();
      const assistantBlocks = j.content;
      working.push({ role: "assistant", content: assistantBlocks });
      for (const block of assistantBlocks) {
        if (block.type === "text" && block.text) {
          this.emit("chatChunk", { streamId, delta: block.text });
        } else if (block.type === "tool_use") {
          const indicator = block.name === "open_tab" ? `

_🌐 opening **${block.input.title || block.input.url}**_` : `

_🔍 searching: **${block.input.query}**_`;
          this.emit("chatChunk", { streamId, delta: indicator });
        }
      }
      if (j.stop_reason !== "tool_use") {
        this.emit("chatDone", { streamId });
        this.streams.delete(streamId);
        return;
      }
      const toolResults = [];
      for (const block of assistantBlocks) {
        if (block.type !== "tool_use") continue;
        let result;
        try {
          if (block.name === "open_tab") {
            const url = block.input.url;
            tools.openTab(url, block.input.title);
            result = `Opened tab to ${url}`;
          } else if (block.name === "web_search") {
            const results = await tools.webSearch(block.input.query);
            result = JSON.stringify(results.slice(0, 10));
          } else {
            result = `Unknown tool: ${block.name}`;
          }
        } catch (err) {
          result = `Tool error: ${err.message}`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      working.push({ role: "user", content: toolResults });
      this.emit("chatChunk", { streamId, delta: "\n\n" });
    }
    this.emit("chatDone", { streamId });
    this.streams.delete(streamId);
  }
}
const TAVILY_URL = "https://api.tavily.com/search";
class SearchService {
  async getKey() {
    const env = process.env.TAVILY_API_KEY;
    if (env) return env;
    return getSecret(KEYCHAIN_KEYS.searchKey);
  }
  async setSearchKey(key) {
    await setSecret(KEYCHAIN_KEYS.searchKey, key);
  }
  /** Direct Tavily web search — sub-second, ~10x faster than going through Claude's web_search tool. */
  async web(query) {
    const key = await this.getKey();
    if (!key) {
      throw new Error("Tavily API key not set. Add it in Settings.");
    }
    const r = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        max_results: 20,
        include_answer: false
      })
    });
    if (r.status === 401) throw new Error("Tavily API key is invalid.");
    if (r.status === 429) throw new Error("Tavily rate limit hit; try again later.");
    if (!r.ok) throw new Error(`Tavily web search failed: ${r.status}`);
    const j = await r.json();
    return (j.results ?? []).filter((x) => x.url).map((x) => ({
      title: x.title ?? x.url ?? "",
      url: x.url ?? "",
      snippet: (x.content ?? "").slice(0, 280)
    }));
  }
  /**
   * Image search via 3 parallel Tavily queries with related phrasings, then
   * deduped. ~3x more images than a single query and roughly the same wall
   * time (parallel). Uses search_depth:basic — `advanced` is slower and
   * doesn't return more images for our use case (we want photos, not deep
   * web crawling).
   */
  async images(query) {
    const key = await this.getKey();
    if (!key) {
      throw new Error("Tavily API key not set. Add it in Settings.");
    }
    const queries = [query, `${query} photos`, `${query} images`];
    const settled = await Promise.allSettled(
      queries.map((q) => this.singleImageQuery(q, key))
    );
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    let firstError = null;
    for (const r of settled) {
      if (r.status === "rejected") {
        firstError ??= r.reason;
        continue;
      }
      for (const img of r.value) {
        if (seen.has(img.thumbnail)) continue;
        seen.add(img.thumbnail);
        out.push(img);
      }
    }
    if (out.length === 0 && firstError) throw firstError;
    return out;
  }
  async singleImageQuery(query, key) {
    const r = await fetch(TAVILY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: "basic",
        include_images: true,
        include_image_descriptions: true,
        max_results: 10
      })
    });
    if (r.status === 401) throw new Error("Tavily API key is invalid.");
    if (r.status === 429) throw new Error("Tavily rate limit hit; try again later.");
    if (!r.ok) throw new Error(`Tavily search failed: ${r.status}`);
    const j = await r.json();
    const images = j.images ?? [];
    const out = [];
    for (const item of images) {
      const isObj = typeof item === "object" && item !== null;
      const url = isObj ? item.url : item;
      if (!url) continue;
      const title = isObj && item.description ? item.description : "";
      out.push({
        thumbnail: url,
        source_url: url,
        page_url: url,
        width: 0,
        height: 0,
        title
      });
    }
    return out;
  }
}
let dbInstance = null;
function db() {
  if (dbInstance) return dbInstance;
  const conn = new Database(dbPath());
  conn.pragma("journal_mode = WAL");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  for (const stmt of MIGRATIONS) {
    try {
      conn.exec(stmt);
    } catch {
    }
  }
  dbInstance = conn;
  return conn;
}
function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visited_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS history_visited_idx ON history (visited_at DESC);
CREATE INDEX IF NOT EXISTS history_url_idx ON history (url);

CREATE TABLE IF NOT EXISTS passwords (
  id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (origin, username)
);
CREATE INDEX IF NOT EXISTS passwords_origin_idx ON passwords (origin);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  cardholder_name TEXT NOT NULL,
  number_enc TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  nickname TEXT,
  last_four TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  folder TEXT,
  created_at INTEGER NOT NULL,
  in_bar INTEGER NOT NULL DEFAULT 0,
  UNIQUE (url, folder)
);
CREATE INDEX IF NOT EXISTS bookmarks_folder_idx ON bookmarks (folder);
`;
const MIGRATIONS = [
  `ALTER TABLE bookmarks ADD COLUMN in_bar INTEGER NOT NULL DEFAULT 0;`,
  `CREATE INDEX IF NOT EXISTS bookmarks_in_bar_idx ON bookmarks (in_bar);`
];
class HistoryService {
  log(url, title) {
    if (!url || url.startsWith("about:") || url.startsWith("chrome:")) return;
    db().prepare("INSERT INTO history (url, title, visited_at) VALUES (?, ?, ?)").run(url, title, Date.now());
  }
  list(opts) {
    const limit = Math.min(opts.limit ?? 200, 1e3);
    if (opts.search) {
      const q = `%${opts.search}%`;
      return db().prepare(
        `SELECT id, url, title, visited_at AS visitedAt
           FROM history
           WHERE url LIKE ? OR title LIKE ?
           ORDER BY visited_at DESC
           LIMIT ?`
      ).all(q, q, limit);
    }
    return db().prepare(
      `SELECT id, url, title, visited_at AS visitedAt
         FROM history
         ORDER BY visited_at DESC
         LIMIT ?`
    ).all(limit);
  }
  clear() {
    db().prepare("DELETE FROM history").run();
  }
}
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
function encrypt(plaintext, key) {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const iv = node_crypto.randomBytes(IV_LEN);
  const cipher = node_crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
function decrypt(ciphertextB64, key) {
  if (key.length !== 32) throw new Error("encryption key must be 32 bytes");
  const buf = Buffer.from(ciphertextB64, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = node_crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
function newKey() {
  return node_crypto.randomBytes(32);
}
const REDACT = "••••••••";
class PasswordService {
  key = null;
  async init() {
    const existing = await getSecret(KEYCHAIN_KEYS.dbKey);
    if (existing) {
      this.key = Buffer.from(existing, "base64");
      return;
    }
    const k = newKey();
    await setSecret(KEYCHAIN_KEYS.dbKey, k.toString("base64"));
    this.key = k;
  }
  getKey() {
    if (!this.key) throw new Error("PasswordService not initialised");
    return this.key;
  }
  list() {
    const rows = db().prepare("SELECT id, origin, username, updated_at AS updatedAt FROM passwords ORDER BY origin").all();
    return rows.map((r) => ({ ...r, password: REDACT }));
  }
  /** Returns cleartext entries. Only call from trusted main-process code paths (page preload). */
  getForOriginCleartext(origin) {
    const rows = db().prepare(
      "SELECT id, origin, username, password_enc AS passwordEnc, updated_at AS updatedAt FROM passwords WHERE origin = ?"
    ).all(origin);
    return rows.map((r) => ({
      id: r.id,
      origin: r.origin,
      username: r.username,
      password: decrypt(r.passwordEnc, this.getKey()),
      updatedAt: r.updatedAt
    }));
  }
  /** Renderer-facing variant: redacts the password. */
  getForOrigin(origin) {
    return this.getForOriginCleartext(origin).map((p) => ({ ...p, password: REDACT }));
  }
  save(origin, username, password) {
    const enc = encrypt(password, this.getKey());
    const now = Date.now();
    const existing = db().prepare("SELECT id FROM passwords WHERE origin = ? AND username = ?").get(origin, username);
    if (existing) {
      db().prepare("UPDATE passwords SET password_enc = ?, updated_at = ? WHERE id = ?").run(enc, now, existing.id);
    } else {
      db().prepare(
        "INSERT INTO passwords (id, origin, username, password_enc, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(node_crypto.randomUUID(), origin, username, enc, now);
    }
  }
  delete(id) {
    db().prepare("DELETE FROM passwords WHERE id = ?").run(id);
  }
}
const REDACT_NUMBER = "•••• •••• •••• ";
class CardService {
  key = null;
  async init() {
    const k = await getSecret(KEYCHAIN_KEYS.dbKey);
    if (!k) throw new Error("CardService: db key missing (init PasswordService first)");
    this.key = Buffer.from(k, "base64");
  }
  getKey() {
    if (!this.key) throw new Error("CardService not initialised");
    return this.key;
  }
  list() {
    const rows = db().prepare(
      "SELECT id, cardholder_name AS cardholderName, exp_month AS expMonth, exp_year AS expYear, nickname, last_four AS lastFour, updated_at AS updatedAt FROM cards ORDER BY updated_at DESC"
    ).all();
    return rows.map((r) => ({
      ...r,
      number: REDACT_NUMBER + r.lastFour
    }));
  }
  save(card) {
    const digits = card.number.replace(/\D/g, "");
    if (digits.length < 12 || digits.length > 19) {
      throw new Error("Card number looks invalid.");
    }
    const lastFour = digits.slice(-4);
    const enc = encrypt(digits, this.getKey());
    const now = Date.now();
    db().prepare(
      `INSERT INTO cards (id, cardholder_name, number_enc, exp_month, exp_year, nickname, last_four, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      node_crypto.randomUUID(),
      card.cardholderName,
      enc,
      card.expMonth,
      card.expYear,
      card.nickname,
      lastFour,
      now
    );
  }
  delete(id) {
    db().prepare("DELETE FROM cards WHERE id = ?").run(id);
  }
  /**
   * Cleartext fetch. The OS-auth gate is enforced by the IPC handler in src/main/index.ts
   * (`confirmCardAccess`) before this method is called — never expose this directly.
   */
  getDecrypted(id) {
    const row = db().prepare(
      `SELECT id, cardholder_name AS cardholderName, number_enc AS numberEnc,
                exp_month AS expMonth, exp_year AS expYear, nickname,
                last_four AS lastFour, updated_at AS updatedAt
         FROM cards WHERE id = ?`
    ).get(id);
    if (!row) return null;
    const number = decrypt(row.numberEnc, this.getKey());
    return {
      id: row.id,
      cardholderName: row.cardholderName,
      number,
      expMonth: row.expMonth,
      expYear: row.expYear,
      nickname: row.nickname,
      lastFour: row.lastFour,
      updatedAt: row.updatedAt
    };
  }
}
const FILTER_LISTS = [
  "https://easylist.to/easylist/easylist.txt",
  "https://easylist.to/easylist/easyprivacy.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/filters.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/badware.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/privacy.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/quick-fixes.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/resource-abuse.txt",
  "https://raw.githubusercontent.com/uBlockOrigin/uAssetsCDN/main/filters/unbreak.txt"
];
const CACHE_VERSION = "v2";
const CACHE_FILE = () => node_path.join(filtersDir(), `engine.${CACHE_VERSION}.bin`);
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1e3;
class AdblockService extends node_events.EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
  }
  blocker = null;
  blockedThisSession = 0;
  async init() {
    if (!this.settings.get().adBlockEnabled) return;
    this.blocker = await this.loadOrFetchEngine();
    this.blocker.enableBlockingInSession(electron.session.defaultSession);
    this.blocker.on("request-blocked", () => {
      this.blockedThisSession += 1;
      this.emit("statsUpdated", { blockedThisSession: this.blockedThisSession });
    });
  }
  async reload() {
    if (this.blocker) this.blocker.disableBlockingInSession(electron.session.defaultSession);
    this.blocker = await adblockerElectron.ElectronBlocker.fromLists(fetch, FILTER_LISTS, { enableCompression: true });
    node_fs.writeFileSync(CACHE_FILE(), this.blocker.serialize());
    this.blocker.enableBlockingInSession(electron.session.defaultSession);
  }
  stats() {
    return { blockedThisSession: this.blockedThisSession };
  }
  async loadOrFetchEngine() {
    const cache2 = CACHE_FILE();
    const stale = !node_fs.existsSync(cache2) || Date.now() - statMtime(cache2) > ONE_WEEK_MS;
    if (!stale) {
      try {
        return adblockerElectron.ElectronBlocker.deserialize(new Uint8Array(node_fs.readFileSync(cache2)));
      } catch {
      }
    }
    const blocker = await adblockerElectron.ElectronBlocker.fromLists(fetch, FILTER_LISTS, { enableCompression: true });
    try {
      node_fs.writeFileSync(cache2, blocker.serialize());
    } catch {
    }
    return blocker;
  }
}
function statMtime(path) {
  try {
    return require("node:fs").statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
function safeNavUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return url;
    if (u.protocol === "about:" && (u.pathname === "" || u.pathname === "blank")) return "about:blank";
    return null;
  } catch {
    return null;
  }
}
const INCOGNITO_PARTITION = "incognito-volatile";
class TabsService extends node_events.EventEmitter {
  constructor(mainWindow2, history, settings, pagePreloadPath) {
    super();
    this.mainWindow = mainWindow2;
    this.history = history;
    this.settings = settings;
    this.pagePreloadPath = pagePreloadPath;
    this.suspendInterval = setInterval(() => this.suspendIdleTabs(), 6e4);
  }
  tabs = /* @__PURE__ */ new Map();
  activeId = null;
  suspendInterval = null;
  closeStack = [];
  dispose() {
    if (this.suspendInterval) clearInterval(this.suspendInterval);
    for (const t of this.tabs.values()) {
      if (t.view) t.view.webContents.close();
    }
    this.tabs.clear();
  }
  list() {
    return [...this.tabs.values()].map((t) => this.toPublic(t));
  }
  /** Snapshot of currently-open tabs suitable for session restore. */
  serialize() {
    return [...this.tabs.values()].filter((t) => !!t.url && t.mode === "web").map((t) => ({ url: t.url, mode: t.mode }));
  }
  create(opts) {
    const id = node_crypto.randomUUID();
    const state = {
      id,
      view: null,
      mode: opts.mode,
      url: opts.url ?? "",
      title: opts.url ?? (opts.incognito ? "Incognito" : "New tab"),
      favicon: null,
      query: null,
      loading: false,
      lastActiveAt: Date.now(),
      bounds: null,
      pinned: false,
      muted: false,
      audible: false,
      incognito: !!opts.incognito
    };
    this.tabs.set(id, state);
    if (opts.url) {
      const safe = safeNavUrl(opts.url);
      if (safe) {
        this.ensureView(state);
        state.view.webContents.loadURL(safe);
        state.url = safe;
      } else {
        state.url = "";
      }
    }
    return this.toPublic(state);
  }
  close(tabId) {
    const t = this.tabs.get(tabId);
    if (!t) return;
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
    this.emit("closed", tabId);
  }
  closeOthers(keepId) {
    for (const id of [...this.tabs.keys()]) {
      const t = this.tabs.get(id);
      if (id !== keepId && t && !t.pinned) this.close(id);
    }
  }
  closeToRight(tabId) {
    const ids = [...this.tabs.keys()];
    const idx = ids.indexOf(tabId);
    if (idx < 0) return;
    for (const id of ids.slice(idx + 1)) {
      const t = this.tabs.get(id);
      if (t && !t.pinned) this.close(id);
    }
  }
  undoClose() {
    const last = this.closeStack.pop();
    if (!last) return null;
    return this.create({ mode: last.mode, url: last.url });
  }
  setPinned(tabId, pinned) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.pinned = pinned;
    this.emitUpdate(t);
  }
  setMuted(tabId, muted) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.muted = muted;
    if (t.view) t.view.webContents.setAudioMuted(muted);
    this.emitUpdate(t);
  }
  navigate(tabId, url) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    const safe = safeNavUrl(url);
    if (!safe) {
      return;
    }
    this.ensureView(t);
    t.url = safe;
    t.loading = true;
    t.view.webContents.loadURL(safe);
    this.emitUpdate(t);
  }
  setMode(tabId, mode, query = null) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.mode = mode;
    t.query = query;
    t.lastActiveAt = Date.now();
    this.emitUpdate(t);
  }
  /** Reorder tabs by moving `fromId` to the position currently held by `toId`. */
  reorder(fromId, toId) {
    if (fromId === toId) return;
    const entries = [...this.tabs.entries()];
    const fromIdx = entries.findIndex(([id]) => id === fromId);
    const toIdx = entries.findIndex(([id]) => id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = entries.splice(fromIdx, 1);
    entries.splice(toIdx, 0, moved);
    this.tabs = new Map(entries);
  }
  setBounds(tabId, bounds) {
    const t = this.tabs.get(tabId);
    if (!t) return;
    t.bounds = bounds;
    if (t.view && this.activeId === tabId) t.view.setBounds(bounds);
  }
  show(tabId) {
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
  hide(tabId) {
    const t = this.tabs.get(tabId);
    if (!t || !t.view) return;
    this.mainWindow.contentView.removeChildView(t.view);
    if (this.activeId === tabId) this.activeId = null;
  }
  goBack(tabId) {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.navigationHistory.goBack();
  }
  goForward(tabId) {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.navigationHistory.goForward();
  }
  reload(tabId) {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.reload();
  }
  zoomBy(tabId, delta) {
    const t = this.tabs.get(tabId);
    if (!t?.view) return 1;
    const next = Math.max(0.25, Math.min(5, t.view.webContents.getZoomFactor() + delta));
    t.view.webContents.setZoomFactor(next);
    return next;
  }
  zoomReset(tabId) {
    const t = this.tabs.get(tabId);
    if (!t?.view) return 1;
    t.view.webContents.setZoomFactor(1);
    return 1;
  }
  toggleDevTools(tabId) {
    const t = this.tabs.get(tabId);
    if (!t?.view) return;
    if (t.view.webContents.isDevToolsOpened()) t.view.webContents.closeDevTools();
    else t.view.webContents.openDevTools({ mode: "detach" });
  }
  print(tabId) {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.print({ silent: false });
  }
  getActiveId() {
    return this.activeId;
  }
  /** Set up find-in-page + bubble results back via the emitter. */
  findInPage(tabId, text, forward = true) {
    const t = this.tabs.get(tabId);
    if (!t?.view || !text) return;
    const wc = t.view.webContents;
    if (!this._findHooked.has(tabId)) {
      this._findHooked.add(tabId);
      wc.on("found-in-page", (_e, result) => {
        this.emit("find", {
          tabId,
          activeMatch: result.activeMatchOrdinal,
          matches: result.matches
        });
      });
    }
    wc.findInPage(text, { forward, findNext: false });
  }
  stopFindInPage(tabId) {
    const t = this.tabs.get(tabId);
    t?.view?.webContents.stopFindInPage("clearSelection");
  }
  async getPageText(tabId) {
    const t = this.tabs.get(tabId);
    if (!t?.view) return "";
    const text = await t.view.webContents.executeJavaScript(
      "document.body.innerText"
    );
    return typeof text === "string" ? text.slice(0, 5e4) : "";
  }
  _findHooked = /* @__PURE__ */ new Set();
  ensureView(t) {
    if (t.view) return;
    const view = new electron.WebContentsView({
      webPreferences: {
        preload: this.pagePreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        // Incognito tabs use an in-memory partition (no `persist:` prefix);
        // history, cookies, and storage are isolated and discarded on quit.
        partition: t.incognito ? INCOGNITO_PARTITION : void 0
      }
    });
    t.view = view;
    const wc = view.webContents;
    wc.on("did-start-loading", () => {
      t.loading = true;
      this.emitUpdate(t);
    });
    wc.on("did-stop-loading", () => {
      t.loading = false;
      this.emitUpdate(t);
    });
    wc.on("page-title-updated", (_e, title) => {
      t.title = title;
      if (!t.incognito) this.history.log(t.url, title);
      this.emitUpdate(t);
    });
    wc.on("did-navigate", (_e, url) => {
      t.url = url;
      this.emitUpdate(t);
    });
    wc.on("did-navigate-in-page", (_e, url) => {
      t.url = url;
      this.emitUpdate(t);
    });
    wc.on("page-favicon-updated", (_e, favicons) => {
      t.favicon = favicons[0] ?? null;
      this.emitUpdate(t);
    });
    wc.on("audio-state-changed", (e) => {
      t.audible = e.audible;
      this.emitUpdate(t);
    });
    wc.setWindowOpenHandler(({ url }) => {
      const safe = safeNavUrl(url);
      if (safe) this.create({ mode: "web", url: safe });
      return { action: "deny" };
    });
    wc.on("context-menu", (_e, params) => {
      const items = [];
      if (params.linkURL) {
        items.push({
          label: "Open Link in New Tab",
          click: () => {
            const safe = safeNavUrl(params.linkURL);
            if (safe) this.create({ mode: "web", url: safe });
          }
        });
        items.push({
          label: "Copy Link Address",
          click: () => electron.clipboard.writeText(params.linkURL)
        });
        items.push({ type: "separator" });
      }
      if (params.mediaType === "image" && params.srcURL) {
        items.push({
          label: "Open Image in New Tab",
          click: () => {
            const safe = safeNavUrl(params.srcURL);
            if (safe) this.create({ mode: "web", url: safe });
          }
        });
        items.push({
          label: "Copy Image Address",
          click: () => electron.clipboard.writeText(params.srcURL)
        });
        items.push({ type: "separator" });
      }
      if (params.selectionText) {
        const snippet = params.selectionText.slice(0, 40).trim();
        items.push({
          label: `Ask Claude about "${snippet}${params.selectionText.length > 40 ? "…" : ""}"`,
          click: () => this.emit("contextSearchClaude", params.selectionText)
        });
        items.push({ role: "copy" });
        items.push({ type: "separator" });
      }
      if (params.isEditable) {
        items.push({ role: "cut" });
        items.push({ role: "copy" });
        items.push({ role: "paste" });
        items.push({ type: "separator" });
      }
      items.push({ label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() });
      items.push({ label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() });
      items.push({ label: "Reload", click: () => wc.reload() });
      items.push({ type: "separator" });
      items.push({ label: "Inspect Element", click: () => wc.inspectElement(params.x, params.y) });
      electron.Menu.buildFromTemplate(items).popup();
    });
  }
  suspendIdleTabs() {
    const idleMs = this.settings.get().suspendIdleMinutes * 6e4;
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
  emitUpdate(t) {
    this.emit("updated", this.toPublic(t));
  }
  toPublic(t) {
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
      incognito: t.incognito
    };
  }
}
function rowToPublic(r) {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    folder: r.folder,
    createdAt: r.createdAt,
    inBar: r.in_bar === 1
  };
}
class BookmarksService {
  list() {
    const rows = db().prepare(
      `SELECT id, url, title, folder, created_at AS createdAt, in_bar
         FROM bookmarks
         ORDER BY in_bar DESC, folder, title`
    ).all();
    return rows.map(rowToPublic);
  }
  listInBar() {
    const rows = db().prepare(
      `SELECT id, url, title, folder, created_at AS createdAt, in_bar
         FROM bookmarks
         WHERE in_bar = 1
         ORDER BY created_at`
    ).all();
    return rows.map(rowToPublic);
  }
  getByUrl(url) {
    const rows = db().prepare(
      `SELECT id, url, title, folder, created_at AS createdAt, in_bar
         FROM bookmarks WHERE url = ?`
    ).all(url);
    return rows.map(rowToPublic);
  }
  setInBar(id, inBar) {
    db().prepare("UPDATE bookmarks SET in_bar = ? WHERE id = ?").run(inBar ? 1 : 0, id);
  }
  add(args) {
    const folder = args.folder ?? null;
    const inBarVal = args.inBar ? 1 : 0;
    const createdAt = Date.now();
    const existing = db().prepare("SELECT id FROM bookmarks WHERE url = ? AND IFNULL(folder, '') = IFNULL(?, '')").get(args.url, folder);
    if (existing) {
      db().prepare("UPDATE bookmarks SET title = ?, in_bar = MAX(in_bar, ?) WHERE id = ?").run(args.title, inBarVal, existing.id);
      const row = db().prepare(
        `SELECT id, url, title, folder, created_at AS createdAt, in_bar
           FROM bookmarks WHERE id = ?`
      ).get(existing.id);
      return rowToPublic(row);
    }
    const id = node_crypto.randomUUID();
    db().prepare(
      `INSERT INTO bookmarks (id, url, title, folder, created_at, in_bar)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, args.url, args.title, folder, createdAt, inBarVal);
    return { id, url: args.url, title: args.title, folder, createdAt, inBar: !!args.inBar };
  }
  delete(id) {
    db().prepare("DELETE FROM bookmarks WHERE id = ?").run(id);
  }
}
const execFileP = node_util.promisify(node_child_process.execFile);
function chromeUserDataDir() {
  const localAppData = process.env.LOCALAPPDATA ?? node_path.join(node_os.homedir(), "AppData", "Local");
  return node_path.join(localAppData, "Google", "Chrome", "User Data");
}
function chromeProfileDirs() {
  const root = chromeUserDataDir();
  if (!node_fs.existsSync(root)) return [];
  const out = [];
  for (const entry of node_fs.readdirSync(root)) {
    if (entry === "Default" || /^Profile \d+$/.test(entry)) {
      out.push(node_path.join(root, entry));
    }
  }
  return out;
}
function localStatePath() {
  return node_path.join(chromeUserDataDir(), "Local State");
}
function readLocalState() {
  if (!node_fs.existsSync(localStatePath())) return null;
  try {
    return JSON.parse(node_fs.readFileSync(localStatePath(), "utf8"));
  } catch {
    return null;
  }
}
function listChromeProfiles() {
  const dirs = chromeProfileDirs();
  const ls = readLocalState();
  const cache2 = ls?.profile?.info_cache ?? {};
  return dirs.map((dir) => {
    const dirName = dir.split(/[\\/]/).pop() ?? "";
    const entry = cache2[dirName];
    const account = (entry?.gaia_name?.trim() || entry?.gaia_given_name?.trim()) ?? null;
    return {
      dir,
      dirName,
      name: entry?.name ?? dirName,
      account: account || null
    };
  });
}
async function dpapiUnprotect(bytes) {
  const b64 = bytes.toString("base64");
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
  `.trim();
  const { stdout } = await execFileP("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    ps
  ]);
  return Buffer.from(stdout.trim(), "base64");
}
async function getChromeMasterKey() {
  if (!node_fs.existsSync(localStatePath())) {
    throw new Error("Chrome not detected (no Local State file).");
  }
  const raw = node_fs.readFileSync(localStatePath(), "utf8");
  const json = JSON.parse(raw);
  const b64 = json.os_crypt?.encrypted_key;
  if (!b64) throw new Error("Chrome Local State has no encrypted key.");
  const enc = Buffer.from(b64, "base64");
  const stripped = enc.subarray(5);
  return dpapiUnprotect(stripped);
}
function decryptChromePassword(encrypted, key) {
  if (encrypted.length < 3) return null;
  const prefix = encrypted.subarray(0, 3).toString("utf8");
  if (prefix === "v10" || prefix === "v11") {
    const iv = encrypted.subarray(3, 15);
    const ciphertext = encrypted.subarray(15, encrypted.length - 16);
    const tag = encrypted.subarray(encrypted.length - 16);
    try {
      const decipher = node_crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}
async function importChromePasswords(passwords, profileDir) {
  const allProfiles = chromeProfileDirs();
  if (allProfiles.length === 0) {
    throw new Error("Chrome User Data folder not found.");
  }
  const profiles = profileDir ? allProfiles.filter((p) => p === profileDir) : allProfiles;
  if (profiles.length === 0) {
    throw new Error("Selected Chrome profile not found.");
  }
  const key = await getChromeMasterKey();
  let imported = 0;
  let skipped = 0;
  for (const profile of profiles) {
    const src = node_path.join(profile, "Login Data");
    if (!node_fs.existsSync(src)) continue;
    const tmpDb = node_path.join(node_os.tmpdir(), `cb-chrome-login-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      node_fs.copyFileSync(src, tmpDb);
    } catch {
      continue;
    }
    const db2 = new Database(tmpDb, { readonly: true });
    try {
      const rows = db2.prepare(
        `SELECT origin_url AS url, username_value AS username, password_value AS pw
           FROM logins
           WHERE blacklisted_by_user = 0`
      ).all();
      for (const row of rows) {
        if (!row.url || !row.username || !row.pw || row.pw.length === 0) {
          skipped++;
          continue;
        }
        const password = decryptChromePassword(row.pw, key);
        if (!password) {
          skipped++;
          continue;
        }
        let origin;
        try {
          origin = new URL(row.url).origin;
        } catch {
          skipped++;
          continue;
        }
        try {
          passwords.save(origin, row.username, password);
          imported++;
        } catch {
          skipped++;
        }
      }
    } finally {
      db2.close();
    }
  }
  return { imported, skipped };
}
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
function importPasswordsCsv(svc, csvPath) {
  const text = node_fs.readFileSync(csvPath, "utf8");
  const rows = parseCsv(text);
  if (rows.length < 2) return { imported: 0, skipped: 0 };
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const urlIdx = header.indexOf("url");
  const userIdx = header.indexOf("username");
  const pwIdx = header.indexOf("password");
  if (urlIdx < 0 || userIdx < 0 || pwIdx < 0) {
    throw new Error("CSV header must contain url, username, password columns.");
  }
  let imported = 0;
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const url = row[urlIdx];
    const username = row[userIdx];
    const password = row[pwIdx];
    if (!url || !username || !password) {
      skipped++;
      continue;
    }
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      skipped++;
      continue;
    }
    try {
      svc.save(origin, username, password);
      imported++;
    } catch {
      skipped++;
    }
  }
  return { imported, skipped };
}
function importChromeBookmarks(svc, profileDir) {
  const allProfiles = chromeProfileDirs();
  if (allProfiles.length === 0) {
    throw new Error("Chrome User Data folder not found.");
  }
  const profiles = profileDir ? allProfiles.filter((p) => p === profileDir) : allProfiles;
  if (profiles.length === 0) {
    throw new Error("Selected Chrome profile not found.");
  }
  const profilesByName = new Map(listChromeProfiles().map((p) => [p.dir, p.name]));
  let imported = 0;
  let skipped = 0;
  let foundFile = false;
  let firstError = null;
  for (const profile of profiles) {
    const path = node_path.join(profile, "Bookmarks");
    if (!node_fs.existsSync(path)) continue;
    foundFile = true;
    const profileName = profilesByName.get(profile) ?? profile.split(/[\\/]/).pop() ?? "";
    let json;
    try {
      json = JSON.parse(node_fs.readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const walk = (node, folder, inBar) => {
      if (node.type === "url" && typeof node.url === "string") {
        try {
          svc.add({
            url: node.url,
            title: node.name ?? "",
            folder: folder || null,
            inBar
          });
          imported++;
        } catch (err2) {
          if (!firstError) firstError = err2;
          skipped++;
        }
      } else if (node.type === "folder" && Array.isArray(node.children)) {
        const sub = folder ? `${folder}/${node.name ?? ""}` : node.name ?? "";
        for (const child of node.children) walk(child, sub, inBar);
      }
    };
    const roots = json.roots ?? {};
    for (const rootKey of ["bookmark_bar", "other", "synced"]) {
      const root = roots[rootKey];
      if (!root) continue;
      const rootName = root.name ?? rootKey;
      const topFolder = `${profileName}/${rootName}`;
      const inBar = rootKey === "bookmark_bar";
      if (Array.isArray(root.children)) {
        for (const child of root.children) walk(child, topFolder, inBar);
      }
    }
  }
  if (!foundFile) throw new Error("No Bookmarks file found in any Chrome profile.");
  const err = firstError;
  if (imported === 0 && skipped > 0 && err) {
    throw new Error(`All ${skipped} bookmarks failed: ${err.message}`);
  }
  return { imported, skipped };
}
try {
  dotenv.config();
} catch {
}
let mainWindow = null;
let tabsService = null;
const RENDERER_DEV_URL = process.env.ELECTRON_RENDERER_URL;
const appRoot = () => electron.app.getAppPath();
const CHROME_PRELOAD = () => node_path.join(appRoot(), "out/preload/chromePreload.js");
const PAGE_PRELOAD = () => node_path.join(appRoot(), "out/preload/pagePreload.js");
const RENDERER_INDEX = () => node_path.join(appRoot(), "out/renderer/index.html");
function createWindow() {
  const iconPath = node_path.join(appRoot(), "build/icon.ico");
  const win = new electron.BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: "Pikammmmm Browser",
    backgroundColor: "#1a1a1a",
    icon: node_fs.existsSync(iconPath) ? iconPath : void 0,
    webPreferences: {
      preload: CHROME_PRELOAD(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  win.once("ready-to-show", () => win.show());
  return win;
}
async function loadRenderer(win) {
  if (RENDERER_DEV_URL) {
    await win.loadURL(RENDERER_DEV_URL);
  } else {
    await win.loadFile(RENDERER_INDEX());
  }
}
function lockExternalNavigation() {
  electron.app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (e, url) => {
      const allowed = url.startsWith(RENDERER_DEV_URL ?? "") || url.startsWith("file://") || url.startsWith("http://") || url.startsWith("https://");
      if (!allowed) {
        e.preventDefault();
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void electron.shell.openExternal(url);
      }
      return { action: "deny" };
    });
  });
}
function deny(perm) {
  return false;
}
async function main() {
  const gotLock = electron.app.requestSingleInstanceLock();
  if (!gotLock) {
    electron.app.quit();
    return;
  }
  electron.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  await electron.app.whenReady();
  electron.session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === "media" && mainWindow && wc === mainWindow.webContents) {
      callback(true);
      return;
    }
    callback(deny());
  });
  lockExternalNavigation();
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
  const bookmarks = new BookmarksService();
  const adblock = new AdblockService(settings);
  db();
  const ubolPath = electron.app.isPackaged ? node_path.join(process.resourcesPath, "ubol") : node_path.join(electron.app.getAppPath(), "resources/ubol");
  if (node_fs.existsSync(ubolPath)) {
    try {
      const ext = await electron.session.defaultSession.loadExtension(ubolPath, {
        allowFileAccess: true
      });
      console.log("[Pikammmmm Browser] uBOL loaded:", ext.name, ext.version);
    } catch (e) {
      console.warn("[Pikammmmm Browser] uBOL load failed:", e);
    }
  } else {
    console.warn("[Pikammmmm Browser] uBOL bundle missing at", ubolPath);
  }
  try {
    await adblock.init();
  } catch (e) {
    console.warn("Adblock init failed:", e);
  }
  mainWindow = createWindow();
  tabsService = new TabsService(mainWindow, history, settings, PAGE_PRELOAD());
  claude.setAgentTools({
    openTab: (url) => {
      tabsService.create({ mode: "web", url });
    },
    webSearch: (query) => search.web(query)
  });
  try {
    if (node_fs.existsSync(sessionPath())) {
      const raw = node_fs.readFileSync(sessionPath(), "utf8");
      const restored = JSON.parse(raw);
      for (const t of restored) {
        if (t?.url && (t.mode === "web" || t.mode === "image" || t.mode === "ai")) {
          tabsService.create({ mode: t.mode, url: t.url });
        }
      }
    }
  } catch {
  }
  const handle = (channel, fn) => {
    electron.ipcMain.handle(channel, async (_e, ...args) => fn(...args));
  };
  handle("auth:start", () => auth.startOAuth());
  handle("auth:signOut", () => auth.signOut());
  handle("auth:getState", () => auth.getState());
  handle("auth:oauthConfigured", () => auth.oauthConfigured());
  handle("auth:setApiKey", (key) => auth.setApiKey(key));
  handle("claude:webSearch", (q) => claude.webSearch(q));
  handle(
    "claude:chatStart",
    ({ messages }) => claude.chatStart(messages)
  );
  handle("claude:chatCancel", (id) => claude.chatCancel(id));
  handle("search:images", (q) => search.images(q));
  handle("search:web", (q) => search.web(q));
  handle("search:setSearchKey", (k) => search.setSearchKey(k));
  handle("tab:create", (opts) => tabsService.create(opts));
  handle("tab:close", (id) => tabsService.close(id));
  handle("tab:list", () => tabsService.list());
  handle(
    "tab:navigate",
    ({ tabId, url }) => tabsService.navigate(tabId, url)
  );
  handle(
    "tab:setMode",
    ({ tabId, mode, query }) => tabsService.setMode(tabId, mode, query ?? null)
  );
  handle(
    "tab:reorder",
    ({ fromId, toId }) => tabsService.reorder(fromId, toId)
  );
  handle(
    "tab:setPinned",
    ({ tabId, pinned }) => tabsService.setPinned(tabId, pinned)
  );
  handle(
    "tab:setMuted",
    ({ tabId, muted }) => tabsService.setMuted(tabId, muted)
  );
  handle("tab:closeOthers", (id) => tabsService.closeOthers(id));
  handle("tab:closeToRight", (id) => tabsService.closeToRight(id));
  handle("tab:undoClose", () => tabsService.undoClose());
  handle(
    "tab:setBounds",
    ({ tabId, bounds }) => tabsService.setBounds(tabId, bounds)
  );
  handle("tab:show", (id) => tabsService.show(id));
  handle("tab:hide", (id) => tabsService.hide(id));
  handle("tab:goBack", (id) => tabsService.goBack(id));
  handle("tab:goForward", (id) => tabsService.goForward(id));
  handle("tab:reload", (id) => tabsService.reload(id));
  handle("tab:print", (id) => tabsService.print(id));
  handle("tab:zoomIn", (id) => tabsService.zoomBy(id, 0.1));
  handle("tab:zoomOut", (id) => tabsService.zoomBy(id, -0.1));
  handle("tab:zoomReset", (id) => tabsService.zoomReset(id));
  handle("tab:toggleDevTools", (id) => tabsService.toggleDevTools(id));
  handle(
    "tab:findInPage",
    ({ tabId, text, forward }) => tabsService.findInPage(tabId, text, forward !== false)
  );
  handle("tab:stopFindInPage", (id) => tabsService.stopFindInPage(id));
  handle("tab:getPageText", (id) => tabsService.getPageText(id));
  handle("history:list", (opts) => history.list(opts));
  handle("history:clear", () => history.clear());
  handle("password:list", () => passwords.list());
  handle("password:delete", (id) => passwords.delete(id));
  handle("password:getForOrigin", (origin) => passwords.getForOrigin(origin));
  handle(
    "password:importChrome",
    (profileDir) => importChromePasswords(passwords, profileDir ?? null)
  );
  handle("chrome:listProfiles", () => listChromeProfiles());
  handle("password:importCsv", async () => {
    if (!mainWindow) throw new Error("Window not ready");
    const r = await electron.dialog.showOpenDialog(mainWindow, {
      title: "Import passwords from Chrome CSV",
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["openFile"]
    });
    if (r.canceled || !r.filePaths[0]) return { imported: 0, skipped: 0 };
    return importPasswordsCsv(passwords, r.filePaths[0]);
  });
  electron.ipcMain.handle("page:passwordsForOrigin", (event, origin) => {
    if (callerOrigin(event.sender.getURL()) !== origin) return [];
    if (!event.sender.session.isPersistent()) return [];
    return passwords.getForOriginCleartext(origin);
  });
  electron.ipcMain.handle(
    "page:savePassword",
    (event, args) => {
      if (callerOrigin(event.sender.getURL()) !== args.origin) {
        throw new Error("Origin mismatch");
      }
      if (!event.sender.session.isPersistent()) return;
      passwords.save(args.origin, args.username, args.password);
    }
  );
  handle("bookmark:list", () => bookmarks.list());
  handle("bookmark:listBar", () => bookmarks.listInBar());
  handle("bookmark:getByUrl", (url) => bookmarks.getByUrl(url));
  handle("bookmark:add", (args) => bookmarks.add(args));
  handle(
    "bookmark:setInBar",
    ({ id, inBar }) => bookmarks.setInBar(id, inBar)
  );
  handle("bookmark:delete", (id) => bookmarks.delete(id));
  handle(
    "bookmark:importChrome",
    (profileDir) => importChromeBookmarks(bookmarks, profileDir ?? null)
  );
  handle("card:list", () => cards.list());
  handle("card:save", (card) => cards.save(card));
  handle("card:delete", (id) => cards.delete(id));
  const gatedDecrypt = async (id) => {
    const ok = await confirmCardAccess();
    if (!ok) return null;
    return cards.getDecrypted(id);
  };
  handle("card:getDecrypted", (id) => gatedDecrypt(id));
  electron.ipcMain.handle("page:fillCard", async (event, id) => {
    if (!callerOrigin(event.sender.getURL())) return null;
    return gatedDecrypt(id);
  });
  electron.ipcMain.handle("page:cardsForAutofill", (event) => {
    if (!callerOrigin(event.sender.getURL())) return [];
    return cards.list();
  });
  handle("settings:get", () => settings.get());
  handle("settings:update", (patch) => {
    const next = settings.update(patch);
    if ("adBlockEnabled" in patch) {
      void adblock.init();
    }
    return next;
  });
  handle("adblock:reload", () => adblock.reload());
  handle("adblock:stats", () => adblock.stats());
  const send = (channel, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(channel, payload);
  };
  auth.on("changed", (s) => send("auth:changed", s));
  claude.on("chatChunk", (p) => send("claude:chatChunk", p));
  claude.on("chatDone", (p) => send("claude:chatDone", p));
  claude.on("chatError", (p) => send("claude:chatError", p));
  tabsService.on("updated", (t) => send("tab:updated", t));
  tabsService.on("closed", (id) => send("tab:closed", id));
  tabsService.on("find", (r) => send("find:result", r));
  tabsService.on(
    "contextSearchClaude",
    (text) => send("menu:command", { command: "searchClaude", payload: { text } })
  );
  adblock.on("statsUpdated", (s) => send("adblock:statsUpdated", s));
  electron.Menu.setApplicationMenu(buildAppMenu(send, tabsService));
  await loadRenderer(mainWindow);
  electron.app.on("window-all-closed", () => {
    if (process.platform !== "darwin") electron.app.quit();
  });
  electron.app.on("activate", async () => {
    if (electron.BrowserWindow.getAllWindows().length === 0 && mainWindow) {
      await loadRenderer(mainWindow);
    }
  });
}
function buildAppMenu(send, tabs) {
  const sendCmd = (command) => send("menu:command", { command });
  const onActiveTab = (fn) => {
    const id = tabs.getActiveId();
    if (id) fn(id);
  };
  return electron.Menu.buildFromTemplate([
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => sendCmd("newTab") },
        { label: "New Incognito Tab", accelerator: "CmdOrCtrl+Shift+N", click: () => sendCmd("newIncognitoTab") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => sendCmd("closeTab") },
        { label: "Reopen Closed Tab", accelerator: "CmdOrCtrl+Shift+T", click: () => sendCmd("undoClose") },
        { type: "separator" },
        { label: "Print…", accelerator: "CmdOrCtrl+P", click: () => onActiveTab((id) => tabs.print(id)) },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { label: "Find in Page", accelerator: "CmdOrCtrl+F", click: () => sendCmd("find") },
        { label: "Focus Address Bar", accelerator: "CmdOrCtrl+L", click: () => sendCmd("focusAddress") }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => onActiveTab((id) => tabs.reload(id)) },
        { label: "Reload (force)", accelerator: "F5", click: () => onActiveTab((id) => tabs.reload(id)) },
        { type: "separator" },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => onActiveTab((id) => tabs.zoomBy(id, 0.1)) },
        { label: "Zoom In (alt)", accelerator: "CmdOrCtrl+Plus", click: () => onActiveTab((id) => tabs.zoomBy(id, 0.1)) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => onActiveTab((id) => tabs.zoomBy(id, -0.1)) },
        { label: "Reset Zoom", accelerator: "CmdOrCtrl+0", click: () => onActiveTab((id) => tabs.zoomReset(id)) },
        { type: "separator" },
        { label: "Toggle DevTools", accelerator: "F12", click: () => onActiveTab((id) => tabs.toggleDevTools(id)) }
      ]
    },
    {
      label: "Tools",
      submenu: [
        { label: "Summarize Page", accelerator: "CmdOrCtrl+Shift+S", click: () => sendCmd("summarizePage") },
        { label: "Translate Page (English)", accelerator: "CmdOrCtrl+Shift+T", click: () => sendCmd("translatePage") },
        { type: "separator" },
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => sendCmd("settings") }
      ]
    }
  ]);
}
function callerOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    return null;
  } catch {
    return null;
  }
}
async function confirmCardAccess() {
  if (!mainWindow) return false;
  const r = await electron.dialog.showMessageBox(mainWindow, {
    type: "question",
    buttons: ["Allow", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: "Confirm autofill",
    message: "Use a saved card?",
    detail: "Claude Browser will autofill card details on this page. Confirm to continue.\n\n(v1 placeholder for Windows Hello — v1.1 will use the OS biometric prompt.)"
  });
  return r.response === 0;
}
electron.app.on("before-quit", () => {
  try {
    if (tabsService) {
      node_fs.writeFileSync(sessionPath(), JSON.stringify(tabsService.serialize(), null, 2));
    }
  } catch {
  }
  tabsService?.dispose();
  closeDb();
});
main().catch((err) => {
  console.error("Fatal startup error:", err);
  electron.app.quit();
});
