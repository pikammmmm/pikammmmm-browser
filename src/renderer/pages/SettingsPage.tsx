import { useEffect, useState } from 'react';
import { useApp } from '../state.js';
import { api } from '../api.js';
import type {
  Bookmark,
  ChromeImportResult,
  HistoryEntry,
  SavedCard,
  SavedPassword,
} from '@shared/types.js';

export function SettingsPage(): JSX.Element {
  const auth = useApp((s) => s.auth);
  const settings = useApp((s) => s.settings);

  return (
    <div className="pane">
      <div className="settings">
        <h1>Settings</h1>

        <AuthSection signedIn={auth.signedIn} method={auth.method} />
        <SearchKeySection />
        <PreferencesSection
          settings={settings}
          onChange={async (patch) => {
            await api.invoke('settings:update', patch);
            const next = await api.invoke('settings:get');
            useApp.setState({ settings: next });
          }}
        />
        <PasswordsSection />
        <BookmarksSection />
        <CardsSection />
        <HistorySection />
        <AdblockSection />
      </div>
    </div>
  );
}

function AuthSection({
  signedIn,
  method,
}: {
  signedIn: boolean;
  method: string;
}): JSX.Element {
  const [key, setKey] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [oauthOk, setOauthOk] = useState(false);
  useEffect(() => {
    void api.invoke('auth:oauthConfigured').then((v) => setOauthOk(Boolean(v)));
  }, []);
  return (
    <section>
      <h3>{signedIn ? 'Claude account' : 'Sign in'}</h3>
      {signedIn ? (
        <div className="row">
          <div className="grow">
            Signed in via <b>{method}</b>.
          </div>
          <button
            className="btn ghost"
            onClick={async () => {
              await api.invoke('auth:signOut');
              const a = await api.invoke('auth:getState');
              useApp.setState({ auth: a });
            }}
          >
            Sign out
          </button>
        </div>
      ) : (
        <>
          <div style={{ color: 'var(--fg-dim)', marginBottom: 10 }}>
            Paste your Anthropic API key to connect Claude. Get one at{' '}
            <a href="https://console.anthropic.com/" target="_blank" rel="noreferrer">
              console.anthropic.com
            </a>
            .
          </div>
          <div className="row">
            <input
              type="password"
              placeholder="sk-ant-..."
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey();
              }}
            />
            <button className="btn" onClick={() => void saveKey()} disabled={!key}>
              Sign in
            </button>
          </div>
          {oauthOk ? (
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn ghost"
                onClick={async () => {
                  setErr(null);
                  try {
                    await api.invoke('auth:start');
                  } catch (e) {
                    setErr((e as Error).message);
                  }
                }}
              >
                Or sign in with Claude account →
              </button>
            </div>
          ) : (
            <div style={{ color: 'var(--fg-dim)', fontSize: 12, marginTop: 8 }}>
              "Sign in with Claude" needs <code>CLAUDE_OAUTH_CLIENT_ID</code> in <code>.env</code>;
              not configured, so the API-key path is the way in.
            </div>
          )}
          {err ? <div className="banner error">{err}</div> : null}
        </>
      )}
    </section>
  );

  async function saveKey(): Promise<void> {
    setErr(null);
    try {
      const a = await api.invoke('auth:setApiKey', key);
      useApp.setState({ auth: a });
      setKey('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }
}

function SearchKeySection(): JSX.Element {
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  return (
    <section>
      <h3>Tavily API key (Image mode)</h3>
      <div style={{ color: 'var(--fg-dim)', marginBottom: 10 }}>
        Free tier (1,000 queries/month, no card). Get a key at{' '}
        <a href="https://app.tavily.com/home" target="_blank" rel="noreferrer">
          app.tavily.com
        </a>
        .
      </div>
      <div className="row">
        <input
          type="password"
          placeholder="tvly-..."
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
        <button className="btn" onClick={() => void save()} disabled={!key}>
          Save
        </button>
      </div>
      {saved ? <div style={{ color: 'var(--fg-dim)' }}>Saved.</div> : null}
    </section>
  );

  async function save(): Promise<void> {
    await api.invoke('search:setSearchKey', key);
    setKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }
}

function PreferencesSection({
  settings,
  onChange,
}: {
  settings: ReturnType<typeof useApp.getState>['settings'];
  onChange: (patch: Partial<NonNullable<ReturnType<typeof useApp.getState>['settings']>>) => Promise<void>;
}): JSX.Element {
  if (!settings) return <section><h3>Preferences</h3>Loading…</section>;
  return (
    <section>
      <h3>Preferences</h3>
      <div className="row">
        <span className="grow">Default mode</span>
        <select
          value={settings.defaultMode}
          onChange={(e) => void onChange({ defaultMode: e.target.value as 'web' | 'image' | 'ai' })}
        >
          <option value="web">Web</option>
          <option value="image">Image</option>
          <option value="ai">AI</option>
        </select>
      </div>
      <div className="row">
        <span className="grow">Theme</span>
        <select
          value={settings.theme}
          onChange={(e) => void onChange({ theme: e.target.value as 'system' | 'light' | 'dark' })}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <div className="row">
        <span className="grow">Suspend background tabs after (minutes)</span>
        <input
          type="number"
          min={1}
          max={120}
          value={settings.suspendIdleMinutes}
          onChange={(e) => void onChange({ suspendIdleMinutes: Number(e.target.value) || 10 })}
        />
      </div>
      <div className="row">
        <span className="grow">Claude model</span>
        <input
          type="text"
          value={settings.claudeModel}
          onChange={(e) => void onChange({ claudeModel: e.target.value })}
        />
      </div>
    </section>
  );
}

function PasswordsSection(): JSX.Element {
  const [items, setItems] = useState<SavedPassword[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const refresh = async (): Promise<void> => {
    setItems(await api.invoke('password:list'));
  };
  useEffect(() => {
    void refresh();
  }, []);

  async function importFromChrome(): Promise<void> {
    setImporting(true);
    setImportMsg(null);
    try {
      const r: ChromeImportResult = await api.invoke('password:importChrome');
      setImportMsg(`Imported ${r.imported} (${r.skipped} skipped).`);
      await refresh();
    } catch (e) {
      setImportMsg((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  return (
    <section>
      <h3>Saved passwords ({items.length})</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn ghost" onClick={importFromChrome} disabled={importing}>
          {importing ? 'Importing…' : 'Import auto (older Chrome)'}
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            setImporting(true);
            setImportMsg(null);
            try {
              const r: ChromeImportResult = await api.invoke('password:importCsv');
              setImportMsg(
                r.imported === 0 && r.skipped === 0
                  ? 'No file selected.'
                  : `Imported ${r.imported} (${r.skipped} skipped).`,
              );
              await refresh();
            } catch (e) {
              setImportMsg((e as Error).message);
            } finally {
              setImporting(false);
            }
          }}
          disabled={importing}
        >
          Import CSV
        </button>
        {importMsg ? (
          <span style={{ color: 'var(--fg-dim)', fontSize: 12 }}>{importMsg}</span>
        ) : null}
      </div>
      <div style={{ color: 'var(--fg-dim)', fontSize: 12, marginBottom: 8 }}>
        Chrome 127+ encrypts passwords with App-Bound Encryption that auto-import can't read.
        In Chrome go to <code>chrome://password-manager/settings</code> → <b>Export passwords</b>,
        then click <b>Import CSV</b> above.
      </div>
      {items.length === 0 ? (
        <div style={{ color: 'var(--fg-dim)' }}>No saved passwords yet. Sign in to a site to save one, or import from Chrome above.</div>
      ) : (
        items.map((p) => (
          <div key={p.id} className="list-row">
            <div className="grow">
              <div>{p.origin}</div>
              <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>{p.username} • {p.password}</div>
            </div>
            <button
              className="btn danger"
              onClick={async () => {
                await api.invoke('password:delete', p.id);
                void refresh();
              }}
            >
              Delete
            </button>
          </div>
        ))
      )}
    </section>
  );
}

function BookmarksSection(): JSX.Element {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const refresh = async (): Promise<void> => {
    setItems(await api.invoke('bookmark:list'));
  };
  useEffect(() => {
    void refresh();
  }, []);

  async function importFromChrome(): Promise<void> {
    setImporting(true);
    setImportMsg(null);
    try {
      const r: ChromeImportResult = await api.invoke('bookmark:importChrome');
      setImportMsg(`Imported ${r.imported} (${r.skipped} skipped).`);
      await refresh();
    } catch (e) {
      setImportMsg((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  const filtered = search
    ? items.filter(
        (b) =>
          b.title.toLowerCase().includes(search.toLowerCase()) ||
          b.url.toLowerCase().includes(search.toLowerCase()),
      )
    : items;

  return (
    <section>
      <h3>Bookmarks ({items.length})</h3>
      <div className="row" style={{ marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Search bookmarks…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn ghost" onClick={importFromChrome} disabled={importing}>
          {importing ? 'Importing…' : 'Import from Chrome'}
        </button>
      </div>
      {importMsg ? (
        <div style={{ color: 'var(--fg-dim)', fontSize: 12, marginBottom: 8 }}>{importMsg}</div>
      ) : null}
      {filtered.length === 0 ? (
        <div style={{ color: 'var(--fg-dim)' }}>
          {items.length === 0 ? 'No bookmarks yet. Import from Chrome to get started.' : 'No matches.'}
        </div>
      ) : (
        <div style={{ maxHeight: 280, overflow: 'auto' }}>
          {filtered.map((b) => (
            <div key={b.id} className="list-row">
              <div className="grow">
                <div>{b.title || b.url}</div>
                <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
                  {b.folder ? `${b.folder} · ` : ''}{b.url}
                </div>
              </div>
              <button
                className="btn ghost"
                onClick={() =>
                  void useApp.getState().newTab('web').then(() => {
                    const id = useApp.getState().activeTabId;
                    if (id) void useApp.getState().navigateUrl(id, b.url);
                  })
                }
              >
                Open
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await api.invoke('bookmark:delete', b.id);
                  void refresh();
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CardsSection(): JSX.Element {
  const [items, setItems] = useState<SavedCard[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [draft, setDraft] = useState({
    cardholderName: '',
    number: '',
    expMonth: 1,
    expYear: new Date().getFullYear(),
    nickname: null as string | null,
  });
  const refresh = async (): Promise<void> => {
    setItems(await api.invoke('card:list'));
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <section>
      <h3>Saved cards ({items.length})</h3>
      {items.length === 0 && !showAdd ? (
        <div style={{ color: 'var(--fg-dim)' }}>No saved cards. Card autofill needs OS confirmation each use.</div>
      ) : null}
      {items.map((c) => (
        <div key={c.id} className="list-row">
          <div className="grow">
            <div>{c.cardholderName} <span style={{ color: 'var(--fg-dim)' }}>•••• {c.lastFour}</span></div>
            <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
              {String(c.expMonth).padStart(2, '0')}/{c.expYear}
              {c.nickname ? ` · ${c.nickname}` : ''}
            </div>
          </div>
          <button
            className="btn danger"
            onClick={async () => {
              await api.invoke('card:delete', c.id);
              void refresh();
            }}
          >
            Delete
          </button>
        </div>
      ))}
      {showAdd ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="text"
            placeholder="Cardholder name"
            value={draft.cardholderName}
            onChange={(e) => setDraft((d) => ({ ...d, cardholderName: e.target.value }))}
          />
          <input
            type="text"
            placeholder="Card number"
            value={draft.number}
            onChange={(e) => setDraft((d) => ({ ...d, number: e.target.value }))}
          />
          <div className="row">
            <input
              type="number"
              min={1}
              max={12}
              placeholder="MM"
              value={draft.expMonth}
              onChange={(e) => setDraft((d) => ({ ...d, expMonth: Number(e.target.value) || 1 }))}
            />
            <input
              type="number"
              min={2024}
              max={2099}
              placeholder="YYYY"
              value={draft.expYear}
              onChange={(e) => setDraft((d) => ({ ...d, expYear: Number(e.target.value) || 2024 }))}
            />
            <input
              type="text"
              placeholder="Nickname (optional)"
              onChange={(e) => setDraft((d) => ({ ...d, nickname: e.target.value || null }))}
            />
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                try {
                  await api.invoke('card:save', draft);
                  setShowAdd(false);
                  setDraft({ cardholderName: '', number: '', expMonth: 1, expYear: new Date().getFullYear(), nickname: null });
                  void refresh();
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
            >
              Save card
            </button>
            <button className="btn ghost" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="btn ghost" onClick={() => setShowAdd(true)}>+ Add card</button>
      )}
    </section>
  );
}

function HistorySection(): JSX.Element {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState('');
  const refresh = async (): Promise<void> => {
    setItems(await api.invoke('history:list', { search, limit: 200 }));
  };
  useEffect(() => {
    void refresh();
  }, [search]);
  return (
    <section>
      <h3>History</h3>
      <div className="row">
        <input
          type="text"
          placeholder="Search history…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="btn danger"
          onClick={async () => {
            if (!confirm('Clear all history?')) return;
            await api.invoke('history:clear');
            void refresh();
          }}
        >
          Clear all
        </button>
      </div>
      <div style={{ maxHeight: 240, overflow: 'auto', marginTop: 8 }}>
        {items.length === 0 ? (
          <div style={{ color: 'var(--fg-dim)' }}>No history.</div>
        ) : (
          items.map((h) => (
            <div key={h.id} className="list-row">
              <div className="grow">
                <div>{h.title || h.url}</div>
                <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>
                  {new Date(h.visitedAt).toLocaleString()} · {h.url}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function AdblockSection(): JSX.Element {
  const [stats, setStats] = useState<{ blockedThisSession: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void api.invoke('adblock:stats').then((s) => alive && setStats(s));
    const off = api.on('adblock:statsUpdated', (s) => alive && setStats(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return (
    <section>
      <h3>Ad blocker</h3>
      <div className="row">
        <div className="grow">Blocked this session</div>
        <b>{stats?.blockedThisSession ?? 0}</b>
      </div>
      <div className="row">
        <button className="btn ghost" onClick={() => void api.invoke('adblock:reload')}>
          Reload filter lists
        </button>
      </div>
    </section>
  );
}
