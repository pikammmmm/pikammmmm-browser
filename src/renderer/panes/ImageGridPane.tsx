import { useApp } from '../state.js';

export function ImageGridPane({ tabId }: { tabId: string }): JSX.Element {
  const ui = useApp((s) => s.ui[tabId]);
  const navigate = useApp((s) => s.navigateUrl);
  const submit = useApp((s) => s.submitQuery);

  if (!ui) return <div className="pane" />;

  if (ui.imageLoading) {
    return (
      <div className="pane empty-state">
        <div className="spinner" />
        <div>Searching images…</div>
      </div>
    );
  }

  if (ui.imageError) {
    const isKeyMissing = /tavily.*key|api key/i.test(ui.imageError);
    return (
      <div className="pane">
        <div className="banner error">
          <div style={{ marginBottom: 8 }}>{ui.imageError}</div>
          {isKeyMissing ? (
            <button onClick={() => useApp.getState().toggleSettings(true)}>Open Settings</button>
          ) : (
            <button onClick={() => ui.query && void submit(tabId, ui.query)}>Retry</button>
          )}
        </div>
      </div>
    );
  }

  if (!ui.imageResults) {
    return (
      <div className="pane empty-state">
        <div>Type a query above and press Enter.</div>
      </div>
    );
  }

  if (ui.imageResults.length === 0) {
    return (
      <div className="pane empty-state">
        <div>No images found.</div>
      </div>
    );
  }

  return (
    <div className="pane">
      <h2>Images for “{ui.query}”</h2>
      <div className="image-grid">
        {ui.imageResults.map((r, i) => (
          <div
            key={`${r.page_url}-${i}`}
            className="image-card"
            onClick={() => void navigate(tabId, r.page_url)}
            title={r.title}
          >
            <img src={r.thumbnail} alt={r.title} loading="lazy" />
          </div>
        ))}
      </div>
    </div>
  );
}
