import { useEffect, useState } from 'react';
import type { Bookmark } from '@shared/types.js';
import { useApp } from '../state.js';
import { api } from '../api.js';

function faviconUrl(pageUrl: string): string | null {
  try {
    const host = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
  } catch {
    return null;
  }
}

export function BookmarkBar(): JSX.Element | null {
  const [items, setItems] = useState<Bookmark[]>([]);
  const navigate = useApp((s) => s.navigateUrl);
  const activeId = useApp((s) => s.activeTabId);
  const newTab = useApp((s) => s.newTab);

  const refresh = async (): Promise<void> => {
    setItems(await api.invoke('bookmark:listBar'));
  };
  useEffect(() => {
    void refresh();
    const off = api.on('tab:updated', () => void refresh());
    const onChanged = (): void => void refresh();
    window.addEventListener('bookmarks-changed', onChanged);
    return () => {
      off();
      window.removeEventListener('bookmarks-changed', onChanged);
    };
  }, []);

  if (items.length === 0) {
    return (
      <div className="bookmark-bar bookmark-bar-empty">
        <span>
          No bookmarks yet. Click ☆ on any page to pin it here, or import from Chrome in Settings.
        </span>
      </div>
    );
  }

  return (
    <div className="bookmark-bar">
      {items.map((b) => {
        const fav = faviconUrl(b.url);
        const label = b.title || new URL(b.url).hostname;
        return (
          <button
            key={b.id}
            className="bookmark-bar-item"
            title={`${b.title}\n${b.url}`}
            onClick={(e) => {
              if (e.button === 1 || e.metaKey || e.ctrlKey) {
                void newTab('web').then(() => {
                  const id = useApp.getState().activeTabId;
                  if (id) void navigate(id, b.url);
                });
                return;
              }
              if (activeId) void navigate(activeId, b.url);
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              void newTab('web').then(() => {
                const id = useApp.getState().activeTabId;
                if (id) void navigate(id, b.url);
              });
            }}
          >
            {fav ? <img src={fav} alt="" /> : <span className="bm-dot" />}
            <span className="bm-label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
