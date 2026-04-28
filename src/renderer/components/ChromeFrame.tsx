import { useEffect, useRef } from 'react';
import { useApp } from '../state.js';
import { api } from '../api.js';
import { WebResultsPane } from '../panes/WebResultsPane.js';
import { ImageGridPane } from '../panes/ImageGridPane.js';
import { AIChatPane } from '../panes/AIChatPane.js';
import { NewTabPage } from '../pages/NewTabPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { FindBar } from './FindBar.js';

/** Wraps the content area; reports its bounds to main so the active WebContentsView can match. */
export function ChromeFrame(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const ui = useApp((s) => s.ui);
  const showSettings = useApp((s) => s.showSettings);

  const containerRef = useRef<HTMLDivElement>(null);
  const tab = tabs.find((t) => t.id === activeId) ?? null;
  const tabUI = activeId ? ui[activeId] : null;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !activeId) return;
    const reportBounds = (): void => {
      const r = el.getBoundingClientRect();
      void api.invoke('tab:setBounds', {
        tabId: activeId,
        bounds: {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
      });
    };
    reportBounds();
    const ro = new ResizeObserver(reportBounds);
    ro.observe(el);
    window.addEventListener('resize', reportBounds);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', reportBounds);
    };
  }, [activeId]);

  // Show/hide the WebContentsView based on what we're rendering. The shell
  // covers the pane area whenever the renderer is showing its own UI.
  useEffect(() => {
    if (!activeId || !tab) return;
    if (showSettings) {
      void api.invoke('tab:hide', activeId);
      return;
    }
    const showsRendererPane =
      (tab.mode === 'web' &&
        (!!tabUI?.query || !!tabUI?.webResults || !!tabUI?.webError || !tab.url)) ||
      tab.mode === 'image' ||
      tab.mode === 'ai';
    if (showsRendererPane) void api.invoke('tab:hide', activeId);
    else void api.invoke('tab:show', activeId);
  }, [activeId, tab?.mode, tab?.url, tabUI?.query, tabUI?.webResults, tabUI?.webError, showSettings, tab]);

  // Show the homepage (centered search bar) for any empty state — not just web.
  // Otherwise users in image / AI mode see only an empty pane and have to use
  // the top address bar with no obvious cue.
  const isEmpty =
    !tab ||
    (tab.mode === 'web' && !tab.url && !tabUI?.query && !tabUI?.webResults && !tabUI?.webError) ||
    (tab.mode === 'image' && !tabUI?.imageResults && !tabUI?.imageError) ||
    (tab.mode === 'ai' && (tabUI?.aiMessages.length ?? 0) === 0);

  return (
    <div className="content" ref={containerRef}>
      <FindBar />
      {showSettings ? (
        <SettingsPage />
      ) : isEmpty ? (
        <NewTabPage />
      ) : tab && tab.mode === 'web' ? (
        tabUI?.query || tabUI?.webResults || tabUI?.webError ? (
          <WebResultsPane tabId={tab.id} />
        ) : null
      ) : tab && tab.mode === 'image' ? (
        <ImageGridPane tabId={tab.id} />
      ) : tab ? (
        <AIChatPane tabId={tab.id} />
      ) : null}
    </div>
  );
}
