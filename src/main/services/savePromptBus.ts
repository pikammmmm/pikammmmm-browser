import { EventEmitter } from 'node:events';

/** Hub for "save password?" prompts coming from per-tab content scripts. */
export class SavePromptBus extends EventEmitter {
  prompt(tabId: string, origin: string, username: string): void {
    this.emit('prompt', { tabId, origin, username });
  }
}
