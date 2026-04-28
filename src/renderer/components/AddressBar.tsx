import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state.js';
import { ModeToggle } from './ModeToggle.js';

export function AddressBar(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const ui = useApp((s) => s.ui);
  const setMode = useApp((s) => s.setMode);
  const submit = useApp((s) => s.submitQuery);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);
  const reload = useApp((s) => s.reload);
  const showSettings = useApp((s) => s.showSettings);

  const tab = tabs.find((t) => t.id === activeId) ?? null;
  const tabUI = activeId ? ui[activeId] : null;

  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!tab) {
      setDraft('');
      return;
    }
    if (tabUI?.query && tab.mode !== 'ai') setDraft(tabUI.query);
    else if (tab.mode === 'web' && tab.url && !tabUI?.query) setDraft(tab.url);
    else setDraft('');
  }, [tab?.id, tab?.url, tab?.mode, tabUI?.query]);

  if (!tab || showSettings) {
    return (
      <div className="bar">
        <div className="bar-nav">
          <button disabled>‹</button>
          <button disabled>›</button>
          <button disabled>↻</button>
        </div>
        <div className="mode-toggle" style={{ visibility: 'hidden' }} />
        <input
          className="address-input"
          placeholder={showSettings ? 'Settings' : 'No tab'}
          disabled
        />
      </div>
    );
  }

  return (
    <div className="bar">
      <div className="bar-nav">
        <button disabled={!tab.canGoBack} onClick={() => goBack(tab.id)} aria-label="Back">
          ‹
        </button>
        <button disabled={!tab.canGoForward} onClick={() => goForward(tab.id)} aria-label="Forward">
          ›
        </button>
        <button onClick={() => reload(tab.id)} aria-label="Reload">
          ↻
        </button>
      </div>
      <ModeToggle value={tab.mode} onChange={(m) => void setMode(tab.id, m)} />
      <input
        ref={inputRef}
        className="address-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit(tab.id, draft);
          }
        }}
        placeholder={
          tab.mode === 'web'
            ? 'Search Claude or enter URL'
            : tab.mode === 'image'
              ? 'Search images'
              : 'Ask Claude anything'
        }
        spellCheck={false}
      />
    </div>
  );
}
