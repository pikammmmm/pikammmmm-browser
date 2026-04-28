import type { IpcEvents, IpcInvoke } from '@shared/ipc.js';

interface Bridge {
  invoke<K extends keyof IpcInvoke>(
    channel: K,
    ...args: Parameters<IpcInvoke[K]>
  ): Promise<ReturnType<IpcInvoke[K]>>;
  on<K extends keyof IpcEvents>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void;
}

declare global {
  interface Window {
    claudeBrowser: {
      invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
      on(channel: string, listener: (payload: unknown) => void): () => void;
    };
  }
}

export const api: Bridge = {
  invoke: ((channel, ...args) =>
    window.claudeBrowser.invoke(channel as string, ...(args as unknown[]))) as Bridge['invoke'],
  on: ((channel, listener) =>
    window.claudeBrowser.on(channel as string, listener as (p: unknown) => void)) as Bridge['on'],
};
