import { useEffect, useRef, useState } from 'react';
import { useApp } from '../state.js';
import { api } from '../api.js';
import { ModeToggle } from './ModeToggle.js';
import { notifyBookmarksChanged } from '../bookmarkEvents.js';
import type { Bookmark } from '@shared/types.js';

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
  const summarizeCurrentPage = useApp((s) => s.summarizeCurrentPage);
  const focusToken = useApp((s) => s.addressFocusToken);

  const tab = tabs.find((t) => t.id === activeId) ?? null;
  const tabUI = activeId ? ui[activeId] : null;

  const [draft, setDraft] = useState('');
  const [bookmarked, setBookmarked] = useState<Bookmark | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // refresh bookmark indicator whenever the active URL changes
  useEffect(() => {
    if (!tab?.url) {
      setBookmarked(null);
      return;
    }
    let cancelled = false;
    void api.invoke('bookmark:getByUrl', tab.url).then((list) => {
      if (cancelled) return;
      setBookmarked(list[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [tab?.url]);

  // external focus trigger (Ctrl+L from menu)
  useEffect(() => {
    if (focusToken > 0 && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [focusToken]);

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
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const value = draft;
            setDraft('');
            void submit(tab.id, value);
          }
        }}
        placeholder={
          tab.mode === 'web'
            ? 'Search the web or enter URL'
            : tab.mode === 'image'
              ? 'Search images'
              : 'Ask Claude — I can also open tabs for you'
        }
        spellCheck={false}
      />
      <button
        className={`star-btn ${bookmarked ? 'on' : ''}`}
        onClick={async () => {
          if (!tab.url) return;
          if (bookmarked) {
            await api.invoke('bookmark:delete', bookmarked.id);
            setBookmarked(null);
          } else {
            const created = await api.invoke('bookmark:add', {
              url: tab.url,
              title: tab.title || tab.url,
              folder: null,
              inBar: true,
            });
            setBookmarked(created);
          }
          notifyBookmarksChanged();
        }}
        title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
        disabled={!tab.url}
      >
        {bookmarked ? '★' : '☆'}
      </button>
      <button
        className="star-btn"
        onClick={() => void summarizeCurrentPage()}
        title="Summarize this page with Claude"
        disabled={!tab.url || tab.mode !== 'web'}
      >
        ✨
      </button>
      {/* Voice mic only on the homepage; it lives in NewTabPage with proper
          inline error handling instead of an alert(). */}
    </div>
  );
}
