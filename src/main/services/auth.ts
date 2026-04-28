import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import type { AuthState } from '@shared/types.js';
import { KEYCHAIN_KEYS } from '@shared/paths.js';
import { deleteSecret, getSecret, setSecret } from '../secrets.js';

interface OAuthConfig {
  clientId: string;
  authUrl: string;
  tokenUrl: string;
}

function readOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.CLAUDE_OAUTH_CLIENT_ID;
  const authUrl = process.env.CLAUDE_OAUTH_AUTH_URL;
  const tokenUrl = process.env.CLAUDE_OAUTH_TOKEN_URL;
  if (!clientId || !authUrl || !tokenUrl) return null;
  return { clientId, authUrl, tokenUrl };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class AuthService extends EventEmitter {
  private state: AuthState = { signedIn: false, method: 'none' };

  async init(): Promise<void> {
    const refresh = await getSecret(KEYCHAIN_KEYS.oauthRefresh);
    const apiKey = await getSecret(KEYCHAIN_KEYS.apiKey);
    if (refresh) this.state = { signedIn: true, method: 'oauth' };
    else if (apiKey) this.state = { signedIn: true, method: 'apiKey' };
    else this.state = { signedIn: false, method: 'none' };
  }

  getState(): AuthState {
    return this.state;
  }

  oauthConfigured(): boolean {
    return readOAuthConfig() !== null;
  }

  async signOut(): Promise<void> {
    await deleteSecret(KEYCHAIN_KEYS.oauthRefresh);
    await deleteSecret(KEYCHAIN_KEYS.oauthAccess);
    await deleteSecret(KEYCHAIN_KEYS.apiKey);
    this.setState({ signedIn: false, method: 'none' });
  }

  async setApiKey(key: string): Promise<AuthState> {
    if (!key.startsWith('sk-ant-')) {
      throw new Error('That doesn\'t look like an Anthropic API key (expected sk-ant-...).');
    }
    await setSecret(KEYCHAIN_KEYS.apiKey, key);
    this.setState({ signedIn: true, method: 'apiKey' });
    return this.state;
  }

  /**
   * Bearer token used by ClaudeService. Prefers OAuth access token, falls back to API key.
   * Returns { kind, value } so the caller can pick the right HTTP header.
   */
  async getCredential(): Promise<{ kind: 'bearer'; value: string } | { kind: 'apiKey'; value: string } | null> {
    const access = await getSecret(KEYCHAIN_KEYS.oauthAccess);
    if (access) return { kind: 'bearer', value: access };
    const key = await getSecret(KEYCHAIN_KEYS.apiKey);
    if (key) return { kind: 'apiKey', value: key };
    return null;
  }

  async startOAuth(): Promise<void> {
    const cfg = readOAuthConfig();
    if (!cfg) {
      throw new Error(
        'Claude OAuth is not configured. Set CLAUDE_OAUTH_* env vars, or paste an API key in Settings.',
      );
    }
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const stateParam = base64url(randomBytes(16));

    const { port, redirectUri, codePromise } = await this.startCallbackServer(stateParam);

    const url = new URL(cfg.authUrl);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'org:create_api_key user:profile');
    url.searchParams.set('state', stateParam);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    void shell.openExternal(url.toString());

    const code = await codePromise;
    void port;
    await this.exchangeCode(cfg, code, verifier, redirectUri);
  }

  private startCallbackServer(expectedState: string): Promise<{
    port: number;
    redirectUri: string;
    codePromise: Promise<string>;
  }> {
    return new Promise((resolveOuter, rejectOuter) => {
      let resolveCode!: (code: string) => void;
      let rejectCode!: (e: Error) => void;
      const codePromise = new Promise<string>((res, rej) => {
        resolveCode = res;
        rejectCode = rej;
      });

      const server: Server = createServer((req, res) => {
        const reqUrl = new URL(req.url ?? '/', 'http://localhost');
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end(`<h1>Sign-in cancelled</h1><p>${error}</p>You can close this tab.`);
          rejectCode(new Error(error));
        } else if (state !== expectedState || !code) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end('<h1>Bad state</h1>You can close this tab.');
          rejectCode(new Error('OAuth state mismatch'));
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<h1>You can close this tab.</h1>Return to Claude Browser.');
          resolveCode(code);
        }
        setTimeout(() => server.close(), 100);
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (typeof addr === 'string' || !addr) {
          rejectOuter(new Error('failed to bind callback server'));
          return;
        }
        const port = addr.port;
        resolveOuter({
          port,
          redirectUri: `http://127.0.0.1:${port}/callback`,
          codePromise,
        });
      });
      server.on('error', rejectOuter);
    });
  }

  private async exchangeCode(
    cfg: OAuthConfig,
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: verifier,
    });
    const r = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!r.ok) throw new Error(`OAuth token exchange failed: ${r.status}`);
    const j = (await r.json()) as { access_token: string; refresh_token?: string };
    await setSecret(KEYCHAIN_KEYS.oauthAccess, j.access_token);
    if (j.refresh_token) await setSecret(KEYCHAIN_KEYS.oauthRefresh, j.refresh_token);
    this.setState({ signedIn: true, method: 'oauth' });
  }

  private setState(s: AuthState): void {
    this.state = s;
    this.emit('changed', s);
  }
}
