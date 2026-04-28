import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../state.js';
import { ModeToggle } from '../components/ModeToggle.js';
import { startVoiceCapture } from '../voice.js';
import type { TabMode } from '@shared/types.js';

export function NewTabPage(): JSX.Element {
  const auth = useApp((s) => s.auth);
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const tab = tabs.find((t) => t.id === activeId) ?? null;
  const setMode = useApp((s) => s.setMode);
  const submit = useApp((s) => s.submitQuery);
  const toggleSettings = useApp((s) => s.toggleSettings);

  const [draft, setDraft] = useState('');
  const [tavilyOk, setTavilyOk] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeId]);

  // Quick-and-dirty config probe — issue an empty image search to see if the
  // Tavily key is configured. We don't actually run it; just detect if the
  // settings look ready.
  useEffect(() => {
    let alive = true;
    void api.invoke('settings:get').then(() => {
      if (!alive) return;
      // Tavily key lives in keychain; we can't check it without trying. Best
      // signal we have: if AI is signed in, Web mode is configured iff Tavily
      // key was saved at some point. Showing a hint regardless is fine.
      setTavilyOk(null);
    });
    return () => {
      alive = false;
    };
  }, []);

  const mode: TabMode = tab?.mode ?? 'web';
  const placeholder =
    mode === 'web'
      ? 'Search the web — type a query or paste a URL'
      : mode === 'image'
        ? 'Search images'
        : 'Ask Claude anything — I can also open tabs for you';

  return (
    <div className="pane new-tab">
      <div className="new-tab-hero">
        <div className="logo">Pikammmmm Browser</div>
        <div className="sub">
          {auth.signedIn
            ? 'Type below — Web is search, Image is image grid, AI lets Claude open tabs for you.'
            : 'Sign in to Claude in Settings to start searching.'}
        </div>

        <div className="big-search">
          <ModeToggle value={mode} onChange={(m) => tab && void setMode(tab.id, m)} />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tab) {
                e.preventDefault();
                void submit(tab.id, draft);
                setDraft('');
              }
            }}
            placeholder={placeholder}
            spellCheck={false}
          />
          <button
            className={`mic ${listening ? 'listening' : ''}`}
            disabled={!tab}
            title="Voice — speak to Claude"
            onClick={async () => {
              if (!tab || listening) return;
              setListening(true);
              try {
                const text = await startVoiceCapture();
                if (text) {
                  await setMode(tab.id, 'ai');
                  await submit(tab.id, text);
                }
              } catch (err) {
                alert((err as Error).message);
              } finally {
                setListening(false);
              }
            }}
          >
            {listening ? '🎙️' : '🎤'}
          </button>
        </div>

        {!auth.signedIn ? (
          <button className="btn" onClick={() => toggleSettings(true)}>
            Open Settings to sign in
          </button>
        ) : (
          <div className="hint">
            Need keys? <a onClick={() => toggleSettings(true)} role="button">Open Settings</a> ·{' '}
            <span>Anthropic API key for Web/AI · Tavily key for Image</span>
          </div>
        )}
      </div>
    </div>
  );
}
