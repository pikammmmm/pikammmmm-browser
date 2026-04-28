import { useApp } from '../state.js';

export function NewTabPage(): JSX.Element {
  const auth = useApp((s) => s.auth);
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeTabId);
  const tab = tabs.find((t) => t.id === activeId) ?? null;
  const toggleSettings = useApp((s) => s.toggleSettings);

  return (
    <div className="pane">
      <div className="new-tab-hero">
        <div className="logo">Claude Browser</div>
        <div className="sub">
          {auth.signedIn ? (
            <>Type a query above. <b>Web</b> uses Claude as your search engine, <b>Image</b> searches images, <b>AI</b> chats with Claude directly.</>
          ) : (
            <>You're not signed in yet. Open Settings to paste an API key or sign in with Claude.</>
          )}
        </div>
        {!auth.signedIn ? (
          <button className="btn" onClick={() => toggleSettings(true)}>Open Settings</button>
        ) : null}
        {tab?.mode ? <div style={{ color: 'var(--fg-dim)' }}>Current mode: <b>{tab.mode}</b></div> : null}
      </div>
    </div>
  );
}
