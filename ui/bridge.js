// Adapt the existing UI to the Rust backend and Tauri's system webview.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const appWindow = window.__TAURI__.window.getCurrentWindow();
const windowAction = (promise) => promise.catch((error) => console.error("Window action failed:", error));

document.getElementById("titlebar-drag").addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  windowAction(event.detail === 2 ? appWindow.toggleMaximize() : appWindow.startDragging());
});
document.getElementById("window-minimize").addEventListener("click", () => windowAction(appWindow.minimize()));
document.getElementById("window-maximize").addEventListener("click", () => windowAction(appWindow.toggleMaximize()));
document.getElementById("window-close").addEventListener("click", () => windowAction(appWindow.close()));
document.querySelectorAll("[data-resize]").forEach((edge) => {
  edge.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    windowAction(appWindow.startResizeDragging(edge.dataset.resize));
  });
});
const handlers = {};
const ready = Promise.all(["scan-progress", "scan-cached", "scan-done", "project-status", "project-log"].map((event) =>
  listen(event, ({ payload }) => { for (const handler of handlers[event] || []) handler(payload); })
));
const call = (action, arg = null) => ready.then(() => invoke("bridge", { action, arg }));
const subscribe = (event, cb) => { (handlers[event] ||= []).push(cb); };
window.api = {
  copyText: (text) => call("copyText", text),
  scan: (opts) => call("scan", opts),
  clearLog: (path) => call("clearLog", path),
  startProject: (path, approvedPids = null) => call("startProject", { path, approvedPids }),
  stopProject: (path) => call("stopProject", path),
  restartProject: (path) => call("restartProject", { path }),
  createProject: (opts) => call("createProject", opts),
  stopAll: () => call("stopAll"),
  killPort: (port, approvedPids = null) => call("killPort", { port, approvedPids }),
  portStatus: (port) => call("portStatus", port),
  getLog: (path) => call("getLog", path),
  getRunning: () => call("getRunning"),
  openConfig: () => call("openConfig"),
  openProjectFolder: (path) => call("openProjectFolder", path),
  openUrl: (url) => call("openUrl", url),
  reloadConfig: () => call("reloadConfig"),
  getConfig: () => call("getConfig"),
  updateConfig: (partial) => call("updateConfig", partial),
  onScanProgress: (cb) => subscribe("scan-progress", cb),
  onScanCached: (cb) => subscribe("scan-cached", cb),
  onScanDone: (cb) => subscribe("scan-done", cb),
  onProjectStatus: (cb) => subscribe("project-status", cb),
  onProjectLog: (cb) => subscribe("project-log", cb),
};
