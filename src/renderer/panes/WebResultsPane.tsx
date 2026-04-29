import { useApp } from '../state.js';

export function WebResultsPane({ tabId }: { tabId: string }): JSX.Element {
  const ui = useApp((s) => s.ui[tabId]);
  const navigate = useApp((s) => s.navigateUrl);
  const submit = useApp((s) => s.submitQuery);
  const newTab = useApp((s) => s.newTab);

  const openInNewTab = async (url: string): Promise<void> => {
    await newTab('web');
    const id = useApp.getState().activeTabId;
    if (id) await navigate(id, url);
  };

  if (!ui) return <div className="pane" />;

  if (ui.webLoading) {
    return (
      <div className="pane empty-state">
        <div className="spinner" />
        <div>Asking Claude…</div>
      </div>
    );
  }

  if (ui.webError) {
    const isKeyMissing = /tavily.*key|api key|sign in/i.test(ui.webError);
    return (
      <div className="pane">
        <div className="banner error">
          <div style={{ marginBottom: 8 }}>{ui.webError}</div>
          {isKeyMissing ? (
            <button
              onClick={() => useApp.getState().toggleSettings(true)}
            >
              Open Settings
            </button>
          ) : (
            <button onClick={() => ui.query && void submit(tabId, ui.query)}>Retry</button>
          )}
        </div>
      </div>
    );
  }

  if (!ui.webResults || ui.webResults.length === 0) {
    return (
      <div className="pane empty-state">
        <div>No results.</div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="results">
        <h2>Results for “{ui.query}”</h2>
        {ui.webResults.map((r) => (
          <div
            key={r.url}
            className="result-card"
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void openInNewTab(r.url);
              }
            }}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) {
                void openInNewTab(r.url);
              } else {
                void navigate(tabId, r.url);
              }
            }}
          >
            <div className="url">{r.url}</div>
            <div className="title">{r.title}</div>
            {r.snippet ? <div className="snippet">{r.snippet}</div> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
