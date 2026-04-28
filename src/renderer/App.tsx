import { useEffect } from 'react';
import { useApp } from './state.js';
import { api } from './api.js';
import { TabStrip } from './components/TabStrip.js';
import { AddressBar } from './components/AddressBar.js';
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
    ];
    return () => offs.forEach((off) => off());
  }, [bootstrap, applyTabUpdate, applyTabClosed, applyChatChunk, applyChatDone, applyChatError, applyAuthChanged]);

  return (
    <div className="app">
      <TabStrip />
      <AddressBar />
      <ChromeFrame />
    </div>
  );
}
