import { useEffect, useRef } from 'react';
import { useApp } from '../state.js';
import { api } from '../api.js';
import { WebResultsPane } from '../panes/WebResultsPane.js';
import { ImageGridPane } from '../panes/ImageGridPane.js';
import { AIChatPane } from '../panes/AIChatPane.js';
import { NewTabPage } from '../pages/NewTabPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';

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

  // Show/hide the WebContentsView based on what we're rendering.
  useEffect(() => {
    if (!activeId || !tab) return;
    if (showSettings) {
      void api.invoke('tab:hide', activeId);
      return;
    }
    const renderingPane =
      (tab.mode === 'web' && (tabUI?.query || tabUI?.webResults || !tab.url)) ||
      tab.mode === 'image' ||
      tab.mode === 'ai';
    if (renderingPane) void api.invoke('tab:hide', activeId);
    else void api.invoke('tab:show', activeId);
  }, [activeId, tab?.mode, tab?.url, tabUI?.query, tabUI?.webResults, showSettings, tab]);

  return (
    <div className="content" ref={containerRef}>
      {showSettings ? (
        <SettingsPage />
      ) : !tab ? (
        <NewTabPage />
      ) : tab.mode === 'web' ? (
        tabUI?.query || tabUI?.webResults ? (
          <WebResultsPane tabId={tab.id} />
        ) : !tab.url ? (
          <NewTabPage />
        ) : null
      ) : tab.mode === 'image' ? (
        <ImageGridPane tabId={tab.id} />
      ) : (
        <AIChatPane tabId={tab.id} />
      )}
    </div>
  );
}
