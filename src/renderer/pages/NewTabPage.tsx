import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state.js';
import { ModeToggle } from '../components/ModeToggle.js';
import { startVoiceCapture, isVoiceSupported } from '../voice.js';
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
  const [listening, setListening] = useState(false);
  const [voiceErr, setVoiceErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [activeId]);

  const mode: TabMode = tab?.mode ?? 'web';
  const placeholder =
    mode === 'web'
      ? 'Search or enter URL'
      : mode === 'image'
        ? 'Search images'
        : 'Ask Claude — can also open tabs for you';

  return (
    <div className="pane new-tab">
      <div className="new-tab-hero">
        <div className="logo">Pikammmmm Browser</div>
        {!auth.signedIn ? (
          <div className="sub">
            Sign in to Claude in Settings to start searching.
          </div>
        ) : null}

        <div className="big-search">
          <ModeToggle value={mode} onChange={(m) => tab && void setMode(tab.id, m)} />
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tab) {
                e.preventDefault();
                const value = draft;
                setDraft('');
                void submit(tab.id, value);
              }
            }}
            placeholder={placeholder}
            spellCheck={false}
            autoFocus
          />
          {isVoiceSupported() ? (
            <button
              className={`mic ${listening ? 'listening' : ''}`}
              disabled={!tab}
              title="Voice — speak to Claude"
              onClick={async () => {
                if (!tab || listening) return;
                setVoiceErr(null);
                setListening(true);
                try {
                  const text = await startVoiceCapture();
                  if (text) {
                    await setMode(tab.id, 'ai');
                    await submit(tab.id, text);
                  }
                } catch (e) {
                  setVoiceErr((e as Error).message);
                } finally {
                  setListening(false);
                }
              }}
            >
              {listening ? '●' : '🎤'}
            </button>
          ) : null}
        </div>

        {voiceErr ? <div className="voice-error">{voiceErr}</div> : null}

        {!auth.signedIn ? (
          <button className="btn" onClick={() => toggleSettings(true)}>
            Open Settings to sign in
          </button>
        ) : (
          <div className="hint">
            Need to add keys?{' '}
            <a onClick={() => toggleSettings(true)} role="button">
              Open Settings
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
