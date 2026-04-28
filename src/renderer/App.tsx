import { useEffect } from 'react';
import { useApp } from './state.js';
import { api } from './api.js';
// re-import for closure use in event handlers
void useApp;
import { TabStrip } from './components/TabStrip.js';
import { AddressBar } from './components/AddressBar.js';
import { BookmarkBar } from './components/BookmarkBar.js';
import { ChromeFrame } from './components/ChromeFrame.js';

export default function App(): JSX.Element {
  const bootstrap = useApp((s) => s.bootstrap);
  const applyTabUpdate = useApp((s) => s.applyTabUpdate);
  const applyTabClosed = useApp((s) => s.applyTabClosed);
  const applyChatChunk = useApp((s) => s.applyChatChunk);
  const applyChatDone = useApp((s) => s.applyChatDone);
  const applyChatError = useApp((s) => s.applyChatError);
  const applyAuthChanged = useApp((s) => s.applyAuthChanged);

  useEffect(() => {
    void bootstrap();
    const offs = [
      api.on('tab:updated', (t) => applyTabUpdate(t)),
      api.on('tab:closed', (id) => applyTabClosed(id)),
      api.on('claude:chatChunk', ({ streamId, delta }) => applyChatChunk(streamId, delta)),
      api.on('claude:chatDone', ({ streamId }) => applyChatDone(streamId)),
      api.on('claude:chatError', ({ streamId, error }) => applyChatError(streamId, error)),
      api.on('auth:changed', (s) => applyAuthChanged(s)),
      api.on('find:result', (r) => useApp.getState().applyFindResult(r)),
      api.on('menu:command', ({ command }) => {
        const s = useApp.getState();
        switch (command) {
          case 'newTab':
            void s.newTab();
            break;
          case 'closeTab':
            if (s.activeTabId) void s.closeTab(s.activeTabId);
            break;
          case 'find':
            s.openFind();
            break;
          case 'focusAddress':
            s.focusAddressBar();
            break;
          case 'summarizePage':
            void s.summarizeCurrentPage();
            break;
          case 'settings':
            s.toggleSettings();
            break;
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [bootstrap, applyTabUpdate, applyTabClosed, applyChatChunk, applyChatDone, applyChatError, applyAuthChanged]);

  return (
    <div className="app">
      <TabStrip />
      <AddressBar />
      <BookmarkBar />
      <ChromeFrame />
    </div>
  );
}
