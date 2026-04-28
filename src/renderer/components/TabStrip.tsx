import { useApp } from '../state.js';

export function TabStrip(): JSX.Element {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const setActive = useApp((s) => s.setActive);
  const newTab = useApp((s) => s.newTab);
  const closeTab = useApp((s) => s.closeTab);
  const toggleSettings = useApp((s) => s.toggleSettings);
  const showSettings = useApp((s) => s.showSettings);

  return (
    <div className="tabstrip">
      {tabs.map((t) => {
        const isActive = t.id === activeId && !showSettings;
        const display = t.title || t.url || (t.mode === 'ai' ? 'New AI chat' : 'New tab');
        return (
          <div
            key={t.id}
            className={`tab ${t.mode} ${isActive ? 'active' : ''}`}
            onClick={() => setActive(t.id)}
            title={display}
          >
            {t.favicon ? (
              <img className="favicon" src={t.favicon} alt="" />
            ) : (
              <span className="mode-pill">{t.mode}</span>
            )}
            <span className="title">{display}</span>
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
          </div>
        );
      })}
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
