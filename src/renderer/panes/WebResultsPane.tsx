import { useApp } from '../state.js';

export function WebResultsPane({ tabId }: { tabId: string }): JSX.Element {
  const ui = useApp((s) => s.ui[tabId]);
  const navigate = useApp((s) => s.navigateUrl);
  const submit = useApp((s) => s.submitQuery);

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
    return (
      <div className="pane">
        <div className="banner error">
          {ui.webError}
          <button onClick={() => ui.query && void submit(tabId, ui.query)}>Retry</button>
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
            onClick={() => void navigate(tabId, r.url)}
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
