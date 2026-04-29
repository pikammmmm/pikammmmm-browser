import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state.js';
import { api } from '../api.js';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';

export function TabStrip(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const setActive = useApp((s) => s.setActive);
  const newTab = useApp((s) => s.newTab);
  const closeTab = useApp((s) => s.closeTab);
  const reorderTabs = useApp((s) => s.reorderTabs);
  const toggleSettings = useApp((s) => s.toggleSettings);
  const showSettings = useApp((s) => s.showSettings);

  // Pinned tabs always render first; within each group, preserve insertion order.
  const ordered = useMemo(() => {
    const pinned = tabs.filter((t) => t.pinned);
    const rest = tabs.filter((t) => !t.pinned);
    return [...pinned, ...rest];
  }, [tabs]);

  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  // Pointer-based drag — HTML5 DnD on <div> elements is unreliable across
  // engines. We track press location, and if the cursor moves more than a
  // few pixels we enter drag mode. While dragging, hovering another tab
  // sets it as the drop target (visual: blue accent ring).
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const pressRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const press = pressRef.current;
      if (!press) return;
      if (!movedRef.current) {
        if (Math.abs(e.clientX - press.x) > 5 || Math.abs(e.clientY - press.y) > 5) {
          movedRef.current = true;
          setDraggedId(press.id);
        } else {
          return;
        }
      }
      const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(
        '[data-tab-id]',
      );
      const targetId = targetEl?.dataset.tabId ?? null;
      if (targetId && targetId !== press.id) setDropTargetId(targetId);
      else setDropTargetId(null);
    };
    const onUp = (): void => {
      const press = pressRef.current;
      pressRef.current = null;
      if (movedRef.current && press && dropTargetId && dropTargetId !== press.id) {
        void reorderTabs(press.id, dropTargetId);
      }
      movedRef.current = false;
      setDraggedId(null);
      setDropTargetId(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dropTargetId, reorderTabs]);

  return (
    <div className="tabstrip">
      {ordered.map((t) => {
        const isActive = t.id === activeId && !showSettings;
        const display = t.title || t.url || (t.mode === 'ai' ? 'New AI chat' : 'New tab');
        const showAudio = t.audible || t.muted;
        return (
          <div
            key={t.id}
            data-tab-id={t.id}
            className={`tab ${t.mode} ${isActive ? 'active' : ''} ${t.pinned ? 'pinned' : ''} ${t.incognito ? 'incognito' : ''} ${draggedId === t.id ? 'dragging' : ''} ${dropTargetId === t.id ? 'drop-target' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, tabId: t.id });
            }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              const tgt = e.target as HTMLElement;
              if (tgt.closest('button')) return; // don't start drag on the close button
              pressRef.current = { id: t.id, x: e.clientX, y: e.clientY };
              movedRef.current = false;
            }}
            onClick={() => {
              if (movedRef.current) return; // suppress click after a drag
              setActive(t.id);
            }}
            title={display}
          >
            {t.incognito ? (
              <span className="mode-pill incog" title="Incognito">🕶</span>
            ) : t.favicon ? (
              <img className="favicon" src={t.favicon} alt="" />
            ) : (
              <span className="mode-pill">{t.mode}</span>
            )}
            {!t.pinned && <span className="title">{display}</span>}
            {showAudio && (
              <button
                className="audio-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  void api.invoke('tab:setMuted', { tabId: t.id, muted: !t.muted });
                }}
                title={t.muted ? 'Unmute tab' : 'Mute tab'}
              >
                {t.muted ? '🔇' : '🔊'}
              </button>
            )}
            {!t.pinned && (
              <button
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(t.id);
                }}
                aria-label="Close tab"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={tabMenuItems(menu.tabId, tabs, closeTab)}
        />
      )}
      <button className="new-tab" onClick={() => void newTab()} aria-label="New tab">
        +
      </button>
      <div className="toolbar-spacer" />
      <button
        className="settings-btn"
        onClick={() => toggleSettings()}
        aria-pressed={showSettings}
      >
        ⚙ Settings
      </button>
    </div>
  );
}

function tabMenuItems(
  tabId: string,
  tabs: ReturnType<typeof useApp.getState>['tabs'],
  closeTab: (id: string) => Promise<void>,
): ContextMenuItem[] {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return [];
  return [
    {
      label: tab.pinned ? 'Unpin tab' : 'Pin tab',
      onClick: () => {
        void api.invoke('tab:setPinned', { tabId, pinned: !tab.pinned });
      },
    },
    {
      label: tab.muted ? 'Unmute tab' : 'Mute tab',
      onClick: () => {
        void api.invoke('tab:setMuted', { tabId, muted: !tab.muted });
      },
      separatorAfter: true,
    },
    {
      label: 'Close tab',
      onClick: () => {
        void closeTab(tabId);
      },
    },
    {
      label: 'Close other tabs',
      disabled: tabs.length < 2,
      onClick: () => {
        void api.invoke('tab:closeOthers', tabId);
      },
    },
    {
      label: 'Close tabs to the right',
      onClick: () => {
        void api.invoke('tab:closeToRight', tabId);
      },
      separatorAfter: true,
    },
    {
      label: 'Reopen closed tab',
      onClick: () => {
        void api.invoke('tab:undoClose');
      },
    },
  ];
}
