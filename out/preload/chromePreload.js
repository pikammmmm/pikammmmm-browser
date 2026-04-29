"use strict";
const electron = require("electron");
const INVOKE_CHANNELS = [
  "auth:start",
  "auth:signOut",
  "auth:getState",
  "auth:oauthConfigured",
  "auth:setApiKey",
  "claude:webSearch",
  "claude:chatStart",
  "claude:chatCancel",
  "search:images",
  "search:web",
  "search:setSearchKey",
  "tab:create",
  "tab:print",
  "tab:close",
  "tab:list",
  "tab:navigate",
  "tab:setMode",
  "tab:reorder",
  "tab:setPinned",
  "tab:setMuted",
  "tab:closeOthers",
  "tab:closeToRight",
  "tab:undoClose",
  "tab:setBounds",
  "tab:show",
  "tab:hide",
  "tab:goBack",
  "tab:goForward",
  "tab:reload",
  "tab:zoomIn",
  "tab:zoomOut",
  "tab:zoomReset",
  "tab:toggleDevTools",
  "tab:findInPage",
  "tab:stopFindInPage",
  "tab:getPageText",
  "history:list",
  "history:clear",
  "bookmark:list",
  "bookmark:listBar",
  "bookmark:getByUrl",
  "bookmark:add",
  "bookmark:setInBar",
  "bookmark:delete",
  "bookmark:importChrome",
  "chrome:listProfiles",
  "password:list",
  "password:delete",
  "password:getForOrigin",
  "password:importChrome",
  "password:importCsv",
  "card:list",
  "card:save",
  "card:delete",
  "card:getDecrypted",
  "settings:get",
  "settings:update",
  "adblock:reload",
  "adblock:stats"
];
const EVENT_CHANNELS = [
  "auth:changed",
  "tab:updated",
  "tab:closed",
  "claude:chatChunk",
  "claude:chatDone",
  "claude:chatError",
  "password:savePrompt",
  "adblock:statsUpdated",
  "find:result",
  "menu:command"
];
const invokeWhitelist = new Set(INVOKE_CHANNELS);
const eventWhitelist = new Set(EVENT_CHANNELS);
function invoke(channel, ...args) {
  if (!invokeWhitelist.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
  return electron.ipcRenderer.invoke(channel, ...args);
}
function on(channel, listener) {
  if (!eventWhitelist.has(channel)) {
    throw new Error(`IPC event channel not allowed: ${channel}`);
  }
  const wrapped = (_e, payload) => listener(payload);
  electron.ipcRenderer.on(channel, wrapped);
  return () => electron.ipcRenderer.off(channel, wrapped);
}
electron.contextBridge.exposeInMainWorld("claudeBrowser", { invoke, on });
