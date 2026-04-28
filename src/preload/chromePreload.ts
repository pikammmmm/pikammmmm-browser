import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@shared/ipc.js';

/** Renderer-facing API. Channel names are whitelisted at build time. */
const invokeWhitelist = new Set<string>(INVOKE_CHANNELS);
const eventWhitelist = new Set<string>(EVENT_CHANNELS);

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  if (!invokeWhitelist.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function on(channel: string, listener: (payload: unknown) => void): () => void {
  if (!eventWhitelist.has(channel)) {
    throw new Error(`IPC event channel not allowed: ${channel}`);
  }
  const wrapped = (_e: unknown, payload: unknown): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

contextBridge.exposeInMainWorld('claudeBrowser', { invoke, on });
