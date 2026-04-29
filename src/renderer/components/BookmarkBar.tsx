import { useEffect, useState } from 'react';
import type { Bookmark } from '@shared/types.js';
import { useApp } from '../state.js';
import { api } from '../api.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { notifyBookmarksChanged } from '../bookmarkEvents.js';

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
  const [menu, setMenu] = useState<{ x: number; y: number; bookmark: Bookmark } | null>(null);

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
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            onClose={() => setMenu(null)}
            items={bookmarkMenuItems(menu.bookmark, refresh, newTab, navigate)}
          />
        )}
      </div>
    );
  }

  return (
    <div
      className="bookmark-bar"
      onWheel={(e) => {
        // Translate vertical wheel to horizontal scroll so users without a
        // shift modifier can scroll through a long bar with a regular mouse.
        if (e.deltaY === 0) return;
        e.currentTarget.scrollLeft += e.deltaY;
      }}
    >
      {items.map((b) => {
        const fav = faviconUrl(b.url);
        const label = b.title || new URL(b.url).hostname;
        return (
          <button
            key={b.id}
            className="bookmark-bar-item"
            title={`${b.title}\n${b.url}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, bookmark: b });
            }}
            onMouseDown={(e) => {
              // Suppress middle-click autoscroll cursor and trigger new-tab open
              // here directly — onAuxClick on <button> elements is unreliable
              // because the click is "consumed" by the button's default handling.
              if (e.button === 1) {
                e.preventDefault();
                void newTab('web').then(() => {
                  const id = useApp.getState().activeTabId;
                  if (id) void navigate(id, b.url);
                });
              }
            }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) {
                void newTab('web').then(() => {
                  const id = useApp.getState().activeTabId;
                  if (id) void navigate(id, b.url);
                });
                return;
              }
              if (activeId) void navigate(activeId, b.url);
            }}
          >
            {fav ? <img src={fav} alt="" /> : <span className="bm-dot" />}
            <span className="bm-label">{label}</span>
          </button>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={bookmarkMenuItems(menu.bookmark, refresh, newTab, navigate)}
        />
      )}
    </div>
  );
}

function bookmarkMenuItems(
  b: Bookmark,
  refresh: () => Promise<void>,
  newTab: (mode?: 'web' | 'image' | 'ai') => Promise<void>,
  navigate: (id: string, url: string) => Promise<void>,
): ContextMenuItem[] {
  return [
    {
      label: 'Open in new tab',
      onClick: () => {
        void newTab('web').then(() => {
          const id = useApp.getState().activeTabId;
          if (id) void navigate(id, b.url);
        });
      },
    },
    {
      label: 'Copy URL',
      onClick: () => {
        void navigator.clipboard.writeText(b.url);
      },
      separatorAfter: true,
    },
    {
      label: 'Remove from bar',
      onClick: async () => {
        await api.invoke('bookmark:setInBar', { id: b.id, inBar: false });
        await refresh();
        notifyBookmarksChanged();
      },
    },
    {
      label: 'Delete bookmark',
      danger: true,
      onClick: async () => {
        await api.invoke('bookmark:delete', b.id);
        await refresh();
        notifyBookmarksChanged();
      },
    },
  ];
}
