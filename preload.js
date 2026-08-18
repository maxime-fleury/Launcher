const { contextBridge, ipcRenderer, clipboard } = require("electron");

contextBridge.exposeInMainWorld("api", {
  copyText: (text) => clipboard.writeText(text),
  scan: (opts) => ipcRenderer.invoke("scan", opts),
  clearLog: (projectPath) => ipcRenderer.invoke("clear-log", projectPath),
  startProject: (projectPath) => ipcRenderer.invoke("start-project", projectPath),
  stopProject: (projectPath) => ipcRenderer.invoke("stop-project", projectPath),
  restartProject: (projectPath) => ipcRenderer.invoke("restart-project", projectPath),
  createProject: (opts) => ipcRenderer.invoke("create-project", opts),
  stopAll: () => ipcRenderer.invoke("stop-all"),
  killPort: (port) => ipcRenderer.invoke("kill-port", port),
  portStatus: (port) => ipcRenderer.invoke("port-status", port),
  getLog: (projectPath) => ipcRenderer.invoke("get-log", projectPath),
  getRunning: () => ipcRenderer.invoke("get-running"),
  openConfig: () => ipcRenderer.invoke("open-config"),
  openProjectFolder: (projectPath) => ipcRenderer.invoke("open-project-folder", projectPath),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  reloadConfig: () => ipcRenderer.invoke("reload-config"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  updateConfig: (partial) => ipcRenderer.invoke("update-config", partial),

  onScanProgress: (cb) => ipcRenderer.on("scan-progress", (_e, p) => cb(p)),
  onScanCached: (cb) => ipcRenderer.on("scan-cached", (_e, p) => cb(p)),
  onScanDone: (cb) => ipcRenderer.on("scan-done", (_e, p) => cb(p)),
  onProjectStatus: (cb) => ipcRenderer.on("project-status", (_e, p) => cb(p)),
  onProjectLog: (cb) => ipcRenderer.on("project-log", (_e, p) => cb(p)),
});
