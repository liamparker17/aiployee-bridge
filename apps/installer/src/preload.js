// preload.js — runs in the renderer's process before any page script,
// with access to Node + Electron APIs. Exposes a narrow contextBridge
// surface so the renderer's HTML/JS cannot directly touch the filesystem
// or spawn processes.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  detectState: () => ipcRenderer.invoke("detect-state"),
  saveAuth: (args) => ipcRenderer.invoke("save-auth", args),
  wireClaude: () => ipcRenderer.invoke("wire-claude"),
  testConnection: () => ipcRenderer.invoke("test-connection"),
  openAiployee: () => ipcRenderer.invoke("open-aiployee"),
  locateBridge: () => ipcRenderer.invoke("locate-bridge"),
});
