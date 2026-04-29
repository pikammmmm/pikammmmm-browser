import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED = new Set([
  'page:passwordsForOrigin',
  'page:cardsForAutofill',
  'page:fillCard',
  'page:savePassword',
]);

const api = {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
    if (!ALLOWED.has(channel)) {
      throw new Error(`page IPC not allowed: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<T>;
  },
};

contextBridge.exposeInMainWorld('claudePage', api);

// Suppress the page's ability to trigger native passkey / Windows Hello
// pickers via the Credentials Management API. We inject a script into the
// main world (preload runs in an isolated world) at document_start so the
// override is in place before any page script can call .get().
function injectMainWorldOverride(): void {
  const code = `
    (() => {
      if (!navigator.credentials) return;
      const real = navigator.credentials.get?.bind(navigator.credentials);
      if (!real) return;
      navigator.credentials.get = function (opts) {
        try {
          // Block silent password / federated / passkey prompts so our own
          // picker isn't pre-empted. Sites can still build explicit sign-in
          // buttons that call this; we resolve null instead of erroring so
          // their flow continues gracefully.
          if (!opts || opts.password || opts.federated || opts.publicKey || opts.mediation === 'conditional') {
            return Promise.resolve(null);
          }
          return real(opts);
        } catch {
          return Promise.resolve(null);
        }
      };
    })();
  `;
  const s = document.createElement('script');
  s.textContent = code;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
}
if (document.readyState === 'loading') {
  document.addEventListener('readystatechange', () => {
    if (document.documentElement) injectMainWorldOverride();
  }, { once: true });
} else {
  injectMainWorldOverride();
}

// ---------- password autofill ----------

interface SavedPassword {
  id: string;
  origin: string;
  username: string;
  password: string;
}

function originFor(): string {
  try {
    return new URL(location.href).origin;
  } catch {
    return '';
  }
}

/**
 * A "login surface" is a password field plus its likely paired username
 * field. We treat each `<input type="password">` on the page as the anchor;
 * the username is the closest preceding text/email-style input within a
 * shared container — works regardless of whether there's an enclosing
 * `<form>` (lots of modern SPAs skip forms).
 */
interface LoginSurface {
  user: HTMLInputElement | null;
  password: HTMLInputElement;
  container: HTMLElement;
}

function findLoginSurfaces(): LoginSurface[] {
  const out: LoginSurface[] = [];
  const seen = new Set<HTMLInputElement>();
  for (const pw of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) {
    if (seen.has(pw)) continue;
    seen.add(pw);
    out.push({
      user: findUserFieldFor(pw),
      password: pw,
      container: pw.form ?? findContainer(pw),
    });
  }
  return out;
}

function findContainer(el: HTMLElement): HTMLElement {
  // Walk up until we find a node that contains both the password input and a
  // text input above it; cap at <body>.
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    if (node.querySelector('input[type="text"], input[type="email"], input:not([type])')) {
      return node;
    }
    node = node.parentElement;
  }
  return document.body;
}

function findUserFieldFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope: ParentNode = pw.form ?? findContainer(pw);
  const candidates = [
    ...scope.querySelectorAll<HTMLInputElement>(
      'input[autocomplete="username"], input[type="email"], input[type="tel"], input[type="text"], input:not([type])',
    ),
  ].filter((el) => el.type !== 'password' && el.type !== 'hidden' && !el.disabled);
  if (candidates.length === 0) return null;
  // Prefer the candidate closest before the password input in DOM order.
  const before = candidates.filter(
    (el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return (before.pop() ?? candidates[0]) ?? null;
}

/** WeakSet of password fields we've already wired so the MutationObserver
 *  can re-run safely without duplicating listeners. */
const wiredPasswordFields = new WeakSet<HTMLInputElement>();

async function fillPasswords(): Promise<void> {
  const surfaces = findLoginSurfaces().filter((s) => !wiredPasswordFields.has(s.password));
  if (surfaces.length === 0) return;
  const origin = originFor();
  const matches = await api.invoke<SavedPassword[]>('page:passwordsForOrigin', origin);
  for (const { user, password: pw, container } of surfaces) {
    wiredPasswordFields.add(pw);
    if (matches.length > 0) {
      const showPicker = (anchor: HTMLInputElement): void => {
        if (document.getElementById('claude-browser-pw-pick')) return;
        showPasswordPicker(anchor, matches, (cred) => {
          if (user) nativeSet(user, cred.username);
          nativeSet(pw, cred.password);
        });
      };
      const onFocus = (e: FocusEvent): void => showPicker(e.target as HTMLInputElement);
      if (user) user.addEventListener('focus', onFocus);
      pw.addEventListener('focus', onFocus);
      continue;
    }

    // No saved creds — offer generated password on password focus.
    pw.addEventListener('focus', () => {
      if (pw.value) return;
      if (document.getElementById('claude-browser-pw-suggest')) return;
      showPasswordSuggestion(pw, (generated) => {
        nativeSet(pw, generated);
        const confirmEls = container.querySelectorAll<HTMLInputElement>(
          'input[autocomplete="new-password"], input[type="password"]',
        );
        for (const el of confirmEls) if (el !== pw) nativeSet(el, generated);
      });
    });
  }
}

function generateStrongPassword(length = 18): string {
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digit = '0123456789';
  const symbol = '!@#$%^&*-_+=?';
  const charset = lower + upper + digit + symbol;
  const arr = new Uint32Array(length);
  crypto.getRandomValues(arr);
  let out = '';
  for (let i = 0; i < length; i++) out += charset[arr[i]! % charset.length];
  return out;
}

function showPasswordSuggestion(
  anchor: HTMLInputElement,
  onPick: (password: string) => void,
): void {
  if (document.getElementById('claude-browser-pw-suggest')) return;
  const rect = anchor.getBoundingClientRect();
  const host = document.createElement('div');
  host.id = 'claude-browser-pw-suggest';
  host.attachShadow({ mode: 'open' });
  const root = host.shadowRoot!;
  let current = generateStrongPassword();
  root.innerHTML = `
    <style>
      .box {
        position: fixed;
        top: ${Math.round(rect.bottom + 4)}px;
        left: ${Math.round(rect.left)}px;
        z-index: 2147483647;
        background: #1a1a1a; color: #fff; padding: 10px;
        border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        font: 13px system-ui, sans-serif; min-width: 280px;
      }
      .label { color: #aaa; font-size: 11px; margin-bottom: 4px; }
      .pw {
        font-family: 'JetBrains Mono', Consolas, monospace;
        background: #2a2a2a; padding: 6px 8px; border-radius: 4px;
        margin-bottom: 8px; word-break: break-all;
      }
      .row { display: flex; gap: 6px; }
      button {
        flex: 1; background: #4a7fff; color: #fff; border: 0;
        padding: 6px 10px; border-radius: 4px; cursor: pointer;
        font: inherit;
      }
      button.ghost { background: transparent; color: #aaa; flex: 0 0 auto; }
    </style>
    <div class="box">
      <div class="label">Pikammmmm Browser suggestion</div>
      <div class="pw" id="pw"></div>
      <div class="row">
        <button id="use">Use this password</button>
        <button id="regen" class="ghost" title="Regenerate">↻</button>
        <button id="cancel" class="ghost">Cancel</button>
      </div>
    </div>
  `;
  const pwEl = root.getElementById('pw')!;
  pwEl.textContent = current;
  root.getElementById('regen')!.addEventListener('click', () => {
    current = generateStrongPassword();
    pwEl.textContent = current;
  });
  root.getElementById('use')!.addEventListener('click', () => {
    onPick(current);
    host.remove();
  });
  root.getElementById('cancel')!.addEventListener('click', () => host.remove());
  document.body.appendChild(host);
  setTimeout(() => {
    document.addEventListener(
      'mousedown',
      (e) => {
        if (!host.contains(e.target as Node)) host.remove();
      },
      { once: true },
    );
  }, 100);
  setTimeout(() => host.remove(), 30_000);
}

function showPasswordPicker(
  anchor: HTMLInputElement,
  creds: SavedPassword[],
  onPick: (cred: SavedPassword) => void,
): void {
  if (document.getElementById('claude-browser-pw-pick')) return;
  const rect = anchor.getBoundingClientRect();
  const host = document.createElement('div');
  host.id = 'claude-browser-pw-pick';
  host.attachShadow({ mode: 'open' });
  const root = host.shadowRoot!;

  let originHost = '';
  try {
    originHost = new URL(creds[0]?.origin ?? location.origin).hostname;
  } catch {
    /* ignore */
  }
  const favicon = originHost
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(originHost)}&sz=32`
    : '';

  const items = creds
    .map(
      (c, i) =>
        `<button class="row" data-i="${i}">
           <img class="favicon" src="${favicon}" alt="" />
           <div class="meta">
             <div class="user">${escapeHtml(c.username)}</div>
             <div class="dots">••••••••••</div>
           </div>
         </button>`,
    )
    .join('');

  root.innerHTML = `
    <style>
      .pick {
        position: fixed; top: ${Math.round(rect.bottom + 6)}px;
        left: ${Math.round(rect.left)}px; z-index: 2147483647;
        background: #1f1f23; color: #f1f1f1; padding: 6px;
        border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
        border: 1px solid #2f2f35;
        font: 13px -apple-system, 'Segoe UI', system-ui, sans-serif;
        display: flex; flex-direction: column; gap: 2px;
        min-width: ${Math.max(280, Math.round(rect.width))}px;
        max-height: 360px; overflow-y: auto;
      }
      .header {
        font-size: 11px; color: #9a9aa3;
        padding: 6px 10px 4px 10px;
        text-transform: uppercase; letter-spacing: .04em;
      }
      .row {
        background: transparent; color: inherit; border: 0;
        padding: 8px 10px; text-align: left; cursor: pointer;
        border-radius: 6px;
        display: flex; align-items: center; gap: 10px;
        font: inherit;
      }
      .row:hover { background: #2a2a2f; }
      .row .favicon { width: 16px; height: 16px; flex: 0 0 16px; border-radius: 3px; }
      .row .meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
      .row .user { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .row .dots { color: #9a9aa3; font-size: 11px; letter-spacing: 1px; }
      .footer {
        border-top: 1px solid #2f2f35; margin-top: 4px; padding-top: 4px;
      }
      .footer .row { color: #9a9aa3; }
    </style>
    <div class="pick">
      <div class="header">Saved passwords for ${escapeHtml(originHost || 'this site')}</div>
      ${items}
      <div class="footer">
        <button class="row" data-i="cancel">
          <div style="width:16px;text-align:center">×</div>
          <div class="meta"><div class="user">Cancel</div></div>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(host);
  root.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = btn.getAttribute('data-i');
      host.remove();
      if (idx === null || idx === 'cancel') return;
      const cred = creds[Number(idx)];
      if (cred) onPick(cred);
    });
  });
  // Auto-dismiss on outside click
  setTimeout(
    () =>
      document.addEventListener(
        'mousedown',
        (e) => {
          if (!host.contains(e.target as Node)) host.remove();
        },
        { once: true },
      ),
    100,
  );
  setTimeout(() => host.remove(), 30_000);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function nativeSet(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as typeof HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function maybeOfferSave(origin: string, username: string, password: string): Promise<void> {
  if (!origin || !username || !password) return;
  // Skip the banner if (origin, username, password) already matches a saved
  // entry. If the username matches but the password differs, treat as an
  // update — same banner copy is fine since saving overwrites.
  try {
    const matches = await api.invoke<SavedPassword[]>('page:passwordsForOrigin', origin);
    const exact = matches.find((m) => m.username === username && m.password === password);
    if (exact) return;
  } catch {
    /* ignore — fall through and offer save */
  }
  offerSaveBanner(origin, username, password);
}

function watchSavePrompt(): void {
  // Form-submit (works for traditional <form> logins).
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target as HTMLFormElement | null;
      if (!form) return;
      const pw = form.querySelector<HTMLInputElement>('input[type="password"]');
      if (!pw || !pw.value) return;
      const user = findUserFieldFor(pw);
      const username = user?.value ?? '';
      void maybeOfferSave(originFor(), username, pw.value);
    },
    true,
  );
  // Click-on-submit-button heuristic for SPA logins without <form>.
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const btn = target.closest('button, [role="button"], input[type="submit"]');
      if (!btn) return;
      const text = (btn.textContent ?? '').toLowerCase();
      if (!/log\s*in|sign\s*in|continue/.test(text)) return;
      const surfaces = findLoginSurfaces();
      for (const { user, password: pw } of surfaces) {
        if (!pw.value) continue;
        const username = user?.value ?? '';
        void maybeOfferSave(originFor(), username, pw.value);
        break;
      }
    },
    true,
  );
}

function offerSaveBanner(origin: string, username: string, password: string): void {
  if (document.getElementById('claude-browser-save-pw')) return;
  const host = document.createElement('div');
  host.id = 'claude-browser-save-pw';
  host.attachShadow({ mode: 'open' });
  const root = host.shadowRoot!;
  root.innerHTML = `
    <style>
      .bar {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
        background: #1a1a1a; color: #fff; font: 14px system-ui, sans-serif;
        padding: 12px 14px; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        display: flex; gap: 8px; align-items: center; max-width: 360px;
      }
      .bar b { font-weight: 600; }
      button {
        background: #6750ff; color: #fff; border: 0; border-radius: 6px;
        padding: 6px 10px; cursor: pointer; font: inherit;
      }
      button.ghost { background: transparent; color: #aaa; }
    </style>
    <div class="bar">
      <span>Save password for <b></b>?</span>
      <button id="save">Save</button>
      <button id="cancel" class="ghost">Not now</button>
    </div>
  `;
  root.querySelector('b')!.textContent = username;
  root.getElementById('save')!.addEventListener('click', () => {
    void api.invoke('page:savePassword', { origin, username, password });
    host.remove();
  });
  root.getElementById('cancel')!.addEventListener('click', () => host.remove());
  document.body.appendChild(host);
  setTimeout(() => host.remove(), 30_000);
}

// ---------- card autofill ----------

interface PublicCard {
  id: string;
  cardholderName: string;
  expMonth: number;
  expYear: number;
  lastFour: string;
}
interface FullCard extends PublicCard {
  number: string;
}

function findCheckoutFields(): {
  number: HTMLInputElement | null;
  expMonth: HTMLInputElement | null;
  expYear: HTMLInputElement | null;
  expCombined: HTMLInputElement | null;
  cardholder: HTMLInputElement | null;
} {
  const sel = <T extends HTMLElement = HTMLInputElement>(q: string): T | null =>
    document.querySelector<T>(q);
  return {
    number: sel<HTMLInputElement>('input[autocomplete="cc-number"]'),
    expMonth: sel<HTMLInputElement>('input[autocomplete="cc-exp-month"]'),
    expYear: sel<HTMLInputElement>('input[autocomplete="cc-exp-year"]'),
    expCombined: sel<HTMLInputElement>('input[autocomplete="cc-exp"]'),
    cardholder: sel<HTMLInputElement>('input[autocomplete="cc-name"]'),
  };
}

function watchCardAutofill(): void {
  // Show a tiny "Autofill card" pill above any cc-number field on focus.
  document.addEventListener(
    'focusin',
    async (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || !(t instanceof HTMLInputElement)) return;
      if (t.autocomplete !== 'cc-number') return;
      const cards = await api.invoke<PublicCard[]>('page:cardsForAutofill');
      if (cards.length === 0) return;
      showCardPicker(t, cards);
    },
    true,
  );
}

function showCardPicker(anchor: HTMLInputElement, cards: PublicCard[]): void {
  if (document.getElementById('claude-browser-cc-pick')) return;
  const rect = anchor.getBoundingClientRect();
  const host = document.createElement('div');
  host.id = 'claude-browser-cc-pick';
  host.attachShadow({ mode: 'open' });
  const root = host.shadowRoot!;
  const items = cards
    .map(
      (c, i) =>
        `<button data-i="${i}">${c.cardholderName} •••• ${c.lastFour} (${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)})</button>`,
    )
    .join('');
  root.innerHTML = `
    <style>
      .pick {
        position: fixed; top: ${Math.round(rect.bottom + 4)}px;
        left: ${Math.round(rect.left)}px; z-index: 2147483647;
        background: #1a1a1a; color: #fff; padding: 6px;
        border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        font: 13px system-ui, sans-serif; display: flex; flex-direction: column; gap: 4px;
      }
      button {
        background: transparent; color: #fff; border: 0;
        padding: 8px 10px; text-align: left; cursor: pointer; border-radius: 4px;
      }
      button:hover { background: #2a2a2a; }
    </style>
    <div class="pick">${items}<button data-i="cancel" style="opacity:.6">Cancel</button></div>
  `;
  document.body.appendChild(host);
  root.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = btn.getAttribute('data-i');
      host.remove();
      if (!idx || idx === 'cancel') return;
      const id = cards[Number(idx)]?.id;
      if (!id) return;
      const full = await api.invoke<FullCard | null>('page:fillCard', id);
      if (!full) return;
      const fields = findCheckoutFields();
      if (fields.number) nativeSet(fields.number, full.number);
      if (fields.cardholder) nativeSet(fields.cardholder, full.cardholderName);
      if (fields.expMonth) nativeSet(fields.expMonth, String(full.expMonth).padStart(2, '0'));
      if (fields.expYear) nativeSet(fields.expYear, String(full.expYear));
      if (fields.expCombined)
        nativeSet(
          fields.expCombined,
          `${String(full.expMonth).padStart(2, '0')}/${String(full.expYear).slice(-2)}`,
        );
    });
  });
  setTimeout(() => host.remove(), 8000);
}

// ---------- bootstrap ----------

/** SPA-friendly: re-run fillPasswords whenever new inputs are inserted into
 *  the DOM. Roblox-style sites render the login form entirely after JS boots. */
function watchForLoginInjection(): void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (
          node.tagName === 'INPUT' ||
          node.querySelector?.('input[type="password"]')
        ) {
          void fillPasswords();
          return;
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

function bootstrap(): void {
  void fillPasswords();
  watchForLoginInjection();
  watchSavePrompt();
  watchCardAutofill();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
