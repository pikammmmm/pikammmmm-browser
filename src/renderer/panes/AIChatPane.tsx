import { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApp } from '../state.js';

export function AIChatPane({ tabId }: { tabId: string }): JSX.Element {
  const ui = useApp((s) => s.ui[tabId]);
  const auth = useApp((s) => s.auth);
  const newTab = useApp((s) => s.newTab);
  const navigate = useApp((s) => s.navigateUrl);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [ui?.aiMessages.length, ui?.aiMessages[ui?.aiMessages.length - 1]?.content]);

  if (!auth.signedIn) {
    return (
      <div className="pane empty-state">
        <h1>Sign in to chat with Claude</h1>
        <div>Open Settings to sign in.</div>
      </div>
    );
  }

  const messages = ui?.aiMessages ?? [];
  if (messages.length === 0) {
    return (
      <div className="pane empty-state">
        <h1>Ask Claude</h1>
        <div>Type a question in the bar above. Code blocks get a copy button; links open in a new tab.</div>
      </div>
    );
  }

  return (
    <div className="pane">
      <div className="chat">
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.role === 'assistant' ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children, ...props }) => (
                    <a
                      {...props}
                      href={href}
                      onClick={(e) => {
                        e.preventDefault();
                        if (!href) return;
                        void newTab('web').then(() => {
                          const id = useApp.getState().activeTabId;
                          if (id) void navigate(id, href);
                        });
                      }}
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {m.content || '…'}
              </ReactMarkdown>
            ) : (
              <span>{m.content}</span>
            )}
          </div>
        ))}
        {ui?.aiError ? <div className="banner error">{ui.aiError}</div> : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
