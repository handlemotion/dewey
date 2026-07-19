import { contextBridge, ipcRenderer } from "electron";
import type {
  ConsequentialAction,
  ConversationMessage,
  DeweyDesktopApi,
  MalcolmTask,
} from "../shared/contracts";

const api: DeweyDesktopApi = {
  bootstrap: () => ipcRenderer.invoke("dewey:bootstrap"),
  createRealtimeSession: () => ipcRenderer.invoke("dewey:create-realtime-session"),
  executeRealtimeTool: (input) => ipcRenderer.invoke("dewey:execute-realtime-tool", input),
  recordMessage: (message) => ipcRenderer.invoke("dewey:record-message", message),
  recordRealtimeUsage: (input) => ipcRenderer.invoke("dewey:record-realtime-usage", input),
  proposeMalcolm: (input) => ipcRenderer.invoke("dewey:propose-malcolm", input),
  decideMalcolm: (input) => ipcRenderer.invoke("dewey:decide-malcolm", input),
  cancelMalcolm: (taskId) => ipcRenderer.invoke("dewey:cancel-malcolm", taskId),
  decideAction: (input) => ipcRenderer.invoke("dewey:decide-action", input),
  updateSettings: (patch) => ipcRenderer.invoke("dewey:update-settings", patch),
  selectWorkspace: () => ipcRenderer.invoke("dewey:select-workspace"),
  configureProvider: (input) => ipcRenderer.invoke("dewey:configure-provider", input),
  clearProvider: (provider) => ipcRenderer.invoke("dewey:clear-provider", provider),
  beginBrowserProfile: (name) => ipcRenderer.invoke("dewey:begin-browser-profile", name),
  finishBrowserProfile: (name) => ipcRenderer.invoke("dewey:finish-browser-profile", name),
  revokeBrowserProfile: (name) => ipcRenderer.invoke("dewey:revoke-browser-profile", name),
  saveMemory: (input) => ipcRenderer.invoke("dewey:save-memory", input),
  updateMemory: (input) => ipcRenderer.invoke("dewey:update-memory", input),
  deleteMemory: (id) => ipcRenderer.invoke("dewey:delete-memory", id),
  onTaskUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, task: MalcolmTask) => listener(task);
    ipcRenderer.on("dewey:task-update", handler);
    return () => ipcRenderer.removeListener("dewey:task-update", handler);
  },
  onActionUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, action: ConsequentialAction) =>
      listener(action);
    ipcRenderer.on("dewey:action-update", handler);
    return () => ipcRenderer.removeListener("dewey:action-update", handler);
  },
  onMessageUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: ConversationMessage) =>
      listener(message);
    ipcRenderer.on("dewey:message-update", handler);
    return () => ipcRenderer.removeListener("dewey:message-update", handler);
  },
};

contextBridge.exposeInMainWorld("dewey", api);
