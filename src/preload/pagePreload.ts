import { contextBridge, ipcRenderer } from 'electron';

const ALLOWED = new Set([
  'page:passwordsForOrigin',
  'page:cardsForAutofill',
  'page:fillCard',
  'password:save',
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

function findLoginForms(): HTMLFormElement[] {
  return [...document.querySelectorAll<HTMLFormElement>('form')].filter(
    (f) => !!f.querySelector('input[type="password"]'),
  );
}

function findUserField(form: HTMLFormElement): HTMLInputElement | null {
  return (
    form.querySelector<HTMLInputElement>('input[autocomplete="username"]') ??
    form.querySelector<HTMLInputElement>('input[type="email"]') ??
    form.querySelector<HTMLInputElement>('input[type="text"]') ??
    null
  );
}

function findPasswordField(form: HTMLFormElement): HTMLInputElement | null {
  return form.querySelector<HTMLInputElement>('input[type="password"]');
}

async function fillPasswords(): Promise<void> {
  const forms = findLoginForms();
  if (forms.length === 0) return;
  const origin = originFor();
  const matches = await api.invoke<SavedPassword[]>('page:passwordsForOrigin', origin);
  if (matches.length === 0) return;
  for (const form of forms) {
    const user = findUserField(form);
    const pw = findPasswordField(form);
    if (!user || !pw) continue;
    const cred = matches[0]!; // simple v1: pick first; multi-account picker is v1.1
    nativeSet(user, cred.username);
    nativeSet(pw, cred.password);
  }
}

function nativeSet(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as typeof HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function watchSavePrompt(): void {
  document.addEventListener(
    'submit',
    (e) => {
      const form = e.target as HTMLFormElement | null;
      if (!form) return;
      const user = findUserField(form);
      const pw = findPasswordField(form);
      if (!user || !pw || !pw.value) return;
      const username = user.value;
      const password = pw.value;
      const origin = originFor();
      if (!username || !password || !origin) return;
      // Show a small in-page banner offering to save.
      offerSaveBanner(origin, username, password);
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
    void api.invoke('password:save', { origin, username, password });
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

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    void fillPasswords();
    watchSavePrompt();
    watchCardAutofill();
  });
} else {
  void fillPasswords();
  watchSavePrompt();
  watchCardAutofill();
}
