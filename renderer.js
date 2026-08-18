const bridge = window.api;

const state = {
  projects: new Map(), // path -> project
  filter: "",
  sort: "custom",
  tabs: new Map(), // path -> { name, hasNew }
  activeTab: null, // path of the tab whose logs are shown
  expanded: new Set(), // paths with details expanded
  scanning: false,
  scanStart: 0,
  runningCount: 0,
  logFollow: true,
  seenPaths: new Set(), // rows already rendered once (only new rows get entrance animation)
  bootRunning: [], // running projects captured at boot, opened as tabs once the list loads
  bootTabsOpened: false,
  firstListLoaded: false,
  customNames: {}, // path -> display name (from config.json)
  customOrder: [], // path[] — user's drag & drop order (from config.json)
  createFolders: [], // folder names offered in the New Project dialog (from config.json)
  scanRoots: [], // first root is where new projects are created
  newProj: { folder: null }, // New Project dialog state
};

const rowEls = new Map(); // path -> { root, nameRow, dotEl, startBtn, restartBtn, uptimeEl, statusEl }

const $ = (id) => document.getElementById(id);
const listEl = $("list");
const emptyEl = $("empty");
const statusEl = $("statusmsg");
const rootsEl = $("roots");
const filterEl = $("filter");
const sortEl = $("sort");
const runningPill = $("runningpill");
const runningCountEl = $("runningcount");
const stopAllBtn = $("btn-stopall");
const progressEl = $("progress");
const logPanel = $("logpanel");
const logTabs = $("logtabs");
const logBody = $("logbody");

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// URLs in log output → clickable links (text is already HTML-escaped)
const LOG_URL_RE = /https?:\/\/[^\s<>"']+/g;

function linkify(text) {
  return text.replace(LOG_URL_RE, (url) => {
    let clean = url;
    while (/[.,;:!?)\]}]+$/.test(clean)) clean = clean.slice(0, -1);
    return `<a class="loglink" href="${clean}">${clean}</a>`;
  });
}

// Terminal escape sequences (colors, cursor moves) — strip so logs stay readable
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

// Subtle line styling: launcher meta lines, echoed commands, process exit notices
function decorate(text) {
  return text
    .replace(/^(\[\d{2}:\d{2}:\d{2}\] \[launcher\].*)$/gm, '<span class="log-meta">$1</span>')
    .replace(/^(\[process exited\].*)$/gm, '<span class="log-exit">$1</span>')
    .replace(/^\$ .*$/gm, '<span class="log-cmd">$&</span>');
}

// Full pipeline: raw chunk → escaped text with links, ANSI stripped, decorated
function renderLogText(text) {
  return decorate(linkify(esc(stripAnsi(text))));
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

const clock = () => new Date().toLocaleTimeString([], { hour12: false });

// Display name: custom rename (if set), else the package name
function displayName(path) {
  const cn = state.customNames[path];
  if (cn) return cn;
  const p = state.projects.get(path);
  if (p && p.name) return p.name;
  return path.split(/[\\/]/).pop() || path;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function toast(msg, type = "info") {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add("out"), 3500);
  setTimeout(() => el.remove(), 4200);
}

// ---------- project list ----------
function visibleProjects() {
  const q = state.filter.trim().toLowerCase();
  const list = [...state.projects.values()];
  const filtered = q
    ? list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          (p.framework || "").toLowerCase().includes(q) ||
          (p.port ? String(p.port).includes(q) : false) ||
          p.script.toLowerCase().includes(q)
      )
    : list;
  const rank = (p) => (p.status === "running" ? 0 : p.status === "starting" ? 1 : p.status === "error" ? 2 : 3);
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  const byPort = (a, b) => (a.port ?? 1e9) - (b.port ?? 1e9) || byName(a, b);
  if (state.sort === "custom") {
    const idx = new Map(state.customOrder.map((p, i) => [p, i]));
    return [...filtered].sort((a, b) => {
      const ia = idx.has(a.path) ? idx.get(a.path) : 1e9;
      const ib = idx.has(b.path) ? idx.get(b.path) : 1e9;
      return ia - ib || byName(a, b);
    });
  }
  if (state.sort === "name") return [...filtered].sort(byName);
  if (state.sort === "port") return [...filtered].sort(byPort);
  return [...filtered].sort((a, b) => rank(a) - rank(b) || byName(a, b));
}

function makeBadge(cls, text, title = "") {
  const b = document.createElement("span");
  b.className = "badge " + cls;
  b.textContent = text;
  if (title) b.title = title;
  return b;
}

function render() {
  const items = visibleProjects();
  listEl.innerHTML = "";
  rowEls.clear();
  emptyEl.classList.toggle("hidden", items.length > 0);

  items.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "row" + (state.activeTab === p.path ? " selected" : "");
    const isNew = !state.seenPaths.has(p.path);
    if (isNew) li.style.animationDelay = `${Math.min(i * 30, 400)}ms`;
    state.seenPaths.add(p.path);

    const isRunning = p.status === "running";
    const isStarting = p.status === "starting";

    const dot = document.createElement("span");
    dot.className = "dot " + (isRunning ? "running" : isStarting ? "starting" : p.status === "error" ? "error" : "");

    const info = document.createElement("div");
    info.className = "info";

    const nameRow = document.createElement("div");
    nameRow.className = "name";

    const chevron = document.createElement("span");
    chevron.className = "chevron " + (state.expanded.has(p.path) ? "open" : "");
    chevron.textContent = "▸";
    chevron.title = "Show details";
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleExpand(p.path);
    });

    if (p.faviconUrl) {
      const img = document.createElement("img");
      img.className = "fav";
      img.src = p.faviconUrl;
      img.alt = "";
      img.onerror = () => img.remove();
      nameRow.appendChild(img);
    }

    const nameEl = document.createElement("span");
    nameEl.className = "name-text";
    nameEl.textContent = displayName(p.path);

    const renBtn = document.createElement("span");
    renBtn.className = "rename-btn";
    renBtn.textContent = "✎";
    renBtn.title = "Rename";
    renBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showRenameInput(p.path, nameEl);
    });

    nameRow.appendChild(chevron);
    nameRow.appendChild(nameEl);
    nameRow.appendChild(renBtn);

    const statusLabel = document.createElement("span");
    statusLabel.className = "statuslabel " + (isRunning ? "run" : isStarting ? "start" : p.status === "error" ? "err" : "off");
    statusLabel.textContent = isRunning ? "RUNNING" : isStarting ? "STARTING…" : p.status === "error" ? "ERROR" : "";
    if (statusLabel.textContent) nameRow.appendChild(statusLabel);

    if (isRunning) {
      const up = document.createElement("span");
      up.className = "uptime";
      up.textContent = "· " + fmtDuration(Date.now() - (p.startedAt || Date.now()));
      nameRow.appendChild(up);
    }

    info.appendChild(nameRow);

    const pathEl = document.createElement("div");
    pathEl.className = "path";
    pathEl.textContent = p.path;
    info.appendChild(pathEl);

    const badges = document.createElement("div");
    badges.className = "badges";

    if (p.framework) badges.appendChild(makeBadge("fw fw-" + p.framework, p.framework));

    if (p.port) {
      const portBadge = makeBadge("port", `🔗 :${p.port}`, isRunning ? "Open http://localhost:" + p.port : "Detected port — click to open");
      portBadge.addEventListener("click", (e) => {
        e.stopPropagation();
        bridge.openUrl("http://localhost:" + p.port);
      });
      if (isRunning) portBadge.classList.add("live");
      if (p.portOverridden) badges.appendChild(makeBadge("override", "override", "Port set in config.json portOverrides"));
      badges.appendChild(portBadge);
    } else {
      badges.appendChild(makeBadge("noport", "no port", "Add a portOverride in config.json to auto-kill the port"));
    }

    badges.appendChild(makeBadge("script", "bun run " + p.script));

    if (p.description) {
      const d = makeBadge("desc", p.description);
      d.title = p.description;
      badges.appendChild(d);
    }

    info.appendChild(badges);

    if (state.expanded.has(p.path)) {
      const det = document.createElement("div");
      det.className = "details";
      det.innerHTML = `
        <div class="det-row"><span class="k">folder</span><span class="det-path">${esc(p.path)}</span><button class="copybtn" data-path="${esc(p.path)}" title="Copy path">⧉</button></div>
        <div class="det-row"><span class="k">script</span> bun run ${esc(p.script)}${p.port ? ` · port <b>${p.port}</b>` : " · <i>no port detected</i>"}${p.portOverridden ? " (override)" : ""}</div>
        ${p.port ? `<div class="det-row"><span class="k">port status</span><span class="portline" data-port="${p.port}">checking…</span></div>` : ""}
        ${p.framework ? `<div class="det-row"><span class="k">framework</span> ${esc(p.framework)}</div>` : ""}
        ${p.description ? `<div class="det-row"><span class="k">about</span> ${esc(p.description)}</div>` : ""}
      `;
      const copyBtn = det.querySelector(".copybtn");
      if (copyBtn) {
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          bridge.copyText(copyBtn.dataset.path);
          toast("Path copied to clipboard", "info");
        });
      }
      info.appendChild(det);
    }

    li.appendChild(dot);
    li.appendChild(info);

    const pinBtn = document.createElement("button");
    pinBtn.className = "btn ghost tiny rowbtn pinbtn";
    pinBtn.textContent = "📌";
    pinBtn.title = "Pin to top (stays after rescans)";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pinToTop(p.path);
    });

    const folderBtn = document.createElement("button");
    folderBtn.className = "btn ghost tiny rowbtn";
    folderBtn.textContent = "📁";
    folderBtn.title = "Open project folder";
    folderBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      bridge.openProjectFolder(p.path);
    });

    const logsBtn = document.createElement("button");
    logsBtn.className = "btn ghost tiny rowbtn";
    logsBtn.textContent = "⎇";
    logsBtn.title = "Show live logs";
    logsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTab(p.path);
    });

    const restartBtn = document.createElement("button");
    restartBtn.className = "btn ghost tiny rowbtn" + (isRunning ? "" : " hidden");
    restartBtn.textContent = "⟳";
    restartBtn.title = "Restart (kills port, starts again)";
    restartBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      doRestart(p.path);
    });

    const startBtn = document.createElement("button");
    startBtn.className = "btn tiny rowbtn start";
    startBtn.textContent = isRunning ? "■ Stop" : isStarting ? "…" : "▶ Start";
    startBtn.disabled = isStarting;
    startBtn.title = isRunning ? "Stop process" : isStarting ? "Starting…" : "Start (kills port first)";
    if (!isRunning && !isStarting) startBtn.classList.add("primary");
    startBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggle(p.path);
    });

    li.appendChild(pinBtn);
    li.appendChild(folderBtn);
    li.appendChild(logsBtn);
    li.appendChild(restartBtn);
    li.appendChild(startBtn);

    li.addEventListener("click", () => toggle(p.path));

    // drag & drop reorder (only in "My order" mode)
    if (state.sort === "custom") {
      const grip = document.createElement("span");
      grip.className = "grip";
      grip.textContent = "⋮⋮";
      grip.title = "Drag to reorder (My order mode)";
      li.insertBefore(grip, li.firstChild);

      li.draggable = true;
      li.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", p.path);
        e.dataTransfer.effectAllowed = "move";
        li.classList.add("dragging");
      });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        li.classList.add("drag-over");
      });
      li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        li.classList.remove("drag-over");
        const from = e.dataTransfer.getData("text/plain");
        if (!from || from === p.path) return;
        reorderProject(from, p.path);
      });
    }

    listEl.appendChild(li);
    rowEls.set(p.path, { root: li, nameRow, dotEl: dot, startBtn, restartBtn, uptimeEl: nameRow.querySelector(".uptime"), statusEl: nameRow.querySelector(".statuslabel") });
  });
}

// Targeted update of a single row's live elements after a status change (no full re-render)
function patchRow(path) {
  const p = state.projects.get(path);
  const els = rowEls.get(path);
  if (!p || !els) return;

  const isRunning = p.status === "running";
  const isStarting = p.status === "starting";
  const isError = p.status === "error";

  els.dotEl.className = "dot " + (isRunning ? "running" : isStarting ? "starting" : isError ? "error" : "");

  els.startBtn.textContent = isRunning ? "■ Stop" : isStarting ? "…" : "▶ Start";
  els.startBtn.disabled = isStarting;
  els.startBtn.classList.toggle("primary", !isRunning && !isStarting);
  els.startBtn.title = isRunning ? "Stop process" : isStarting ? "Starting…" : "Start (kills port first)";

  els.restartBtn.classList.toggle("hidden", !isRunning);

  let label = els.statusEl;
  if (!label) {
    label = document.createElement("span");
    label.className = "statuslabel";
    els.nameRow.appendChild(label);
    els.statusEl = label;
  }
  label.textContent = isRunning ? "RUNNING" : isStarting ? "STARTING…" : isError ? "ERROR" : "";
  label.className = "statuslabel " + (isRunning ? "run" : isStarting ? "start" : isError ? "err" : "");

  const portBadge = els.root.querySelector(".badge.port");
  if (portBadge) portBadge.classList.toggle("live", isRunning);

  if (isRunning && p.startedAt) {
    if (!els.uptimeEl) {
      els.uptimeEl = document.createElement("span");
      els.uptimeEl.className = "uptime";
      els.nameRow.appendChild(els.uptimeEl);
    }
    els.uptimeEl.textContent = "· " + fmtDuration(Date.now() - p.startedAt);
  } else if (els.uptimeEl) {
    els.uptimeEl.remove();
    els.uptimeEl = null;
  }
}

function toggleExpand(path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  render();
  fillPortStatuses();
}

// Async fill of the "port status" lines in expanded details (in use by who / free)
async function fillPortStatuses() {
  const lines = document.querySelectorAll(".portline[data-port]");
  for (const line of lines) {
    const port = parseInt(line.dataset.port, 10);
    const res = await bridge.portStatus(port);
    if (!line.isConnected) return; // row was re-rendered meanwhile
    if (res.inUse) {
      const names = res.users.map((u) => `PID ${u.pid}${u.name ? ` (${u.name})` : ""}`).join(", ");
      line.textContent = `in use by ${names}`;
      line.className = "portline busy";
    } else {
      line.textContent = "free";
      line.className = "portline free";
    }
  }
}

async function toggle(projectPath) {
  const p = state.projects.get(projectPath);
  if (!p) return;
  if (p.status === "running" || p.status === "starting") {
    await bridge.stopProject(projectPath);
  } else {
    openTab(projectPath);
    toast(`Starting <b>${esc(displayName(projectPath))}</b>…`, "info");
    const res = await bridge.startProject(projectPath);
    if (!res.ok) toast(`Failed to start: ${res.message}`, "error");
  }
}

async function doRestart(projectPath) {
  const p = state.projects.get(projectPath);
  if (!p) return;
  openTab(projectPath);
  toast(`Restarting <b>${esc(displayName(projectPath))}</b>…`, "info");
  const res = await bridge.restartProject(projectPath);
  if (!res.ok) toast(`Restart failed: ${res.message}`, "error");
}

// ---------- rename ----------
function showRenameInput(path, nameEl) {
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = state.customNames[path] || "";
  input.placeholder = displayName(path);
  input.title = "Enter to save, Esc to cancel, empty to revert";
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v) state.customNames[path] = v;
    else delete state.customNames[path];
    bridge.updateConfig({ customNames: state.customNames });
    render();
    renderTabs();
    toast(v ? `Renamed to <b>${esc(v)}</b>` : "Reverted to package name", "info");
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") commit();
    if (e.key === "Escape") render();
  });
  input.addEventListener("blur", commit);
  input.addEventListener("click", (e) => e.stopPropagation());
}

// ---------- reorder ----------
// Move a project to the very top of the custom order (works in any sort mode)
function pinToTop(path) {
  state.customOrder = [path, ...state.customOrder.filter((p) => p !== path)];
  bridge.updateConfig({ customOrder: state.customOrder });
  render();
  toast(`📌 Pinned <b>${esc(displayName(path))}</b> to top`, "success");
}

function reorderProject(fromPath, toPath) {
  const list = [...state.customOrder];
  if (!list.includes(fromPath)) list.push(fromPath);
  if (!list.includes(toPath)) list.push(toPath);
  const fi = list.indexOf(fromPath);
  const ti = list.indexOf(toPath);
  list.splice(fi, 1);
  list.splice(ti, 0, fromPath);
  state.customOrder = list;
  bridge.updateConfig({ customOrder: state.customOrder });
  render();
}

// ---------- uptime ticking ----------
setInterval(() => {
  for (const [path, els] of rowEls) {
    const p = state.projects.get(path);
    if (p && p.status === "running" && els.uptimeEl && p.startedAt) {
      els.uptimeEl.textContent = "· " + fmtDuration(Date.now() - p.startedAt);
    }
  }
}, 1000);

// ---------- terminal tabs ----------
function tabName(path) {
  const cn = state.customNames[path];
  if (cn) return cn;
  const p = state.projects.get(path);
  if (p && p.name) return p.name;
  const t = state.tabs.get(path);
  if (t && t.name) return t.name;
  return path.split(/[\\/]/).pop() || path;
}

function openTab(projectPath, { activate = true } = {}) {
  if (!state.tabs.has(projectPath)) {
    state.tabs.set(projectPath, { name: tabName(projectPath), hasNew: false });
  }
  logPanel.classList.remove("hidden");
  if (activate) activateTab(projectPath);
  else renderTabs();
}

function activateTab(projectPath) {
  state.activeTab = projectPath;
  const t = state.tabs.get(projectPath);
  if (t) t.hasNew = false;
  logPanel.classList.remove("hidden");
  renderTabs();
  loadLogs(projectPath);
  render(); // update row highlight
}

function closeTab(projectPath) {
  state.tabs.delete(projectPath);
  if (state.activeTab === projectPath) {
    const remaining = [...state.tabs.keys()];
    const next = remaining.length ? remaining[remaining.length - 1] : null;
    if (next) {
      activateTab(next);
      return;
    }
    state.activeTab = null;
    logPanel.classList.add("hidden");
  }
  renderTabs();
  render();
}

function tabStatusClass(path) {
  const p = state.projects.get(path);
  if (p?.status === "running") return "run";
  if (p?.status === "starting") return "start";
  if (p?.status === "error") return "err";
  return "";
}

function renderTabs() {
  logTabs.innerHTML = "";
  for (const [path] of state.tabs) {
    const btn = document.createElement("div");
    btn.className = "ltab" + (path === state.activeTab ? " active" : "");

    const proj = state.projects.get(path);
    if (proj && proj.faviconUrl) {
      const img = document.createElement("img");
      img.className = "tfav";
      img.src = proj.faviconUrl;
      img.alt = "";
      img.onerror = () => img.remove();
      btn.appendChild(img);
    }

    const dot = document.createElement("span");
    dot.className = "tdot " + tabStatusClass(path);

    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = tabName(path);
    name.title = path;

    btn.appendChild(dot);
    btn.appendChild(name);

    const t = state.tabs.get(path);
    if (t && t.hasNew && path !== state.activeTab) {
      const n = document.createElement("span");
      n.className = "tnew";
      n.title = "New output";
      btn.appendChild(n);
    }

    const close = document.createElement("span");
    close.className = "tclose";
    close.textContent = "✕";
    close.title = "Close tab (process keeps running)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(path);
    });

    btn.appendChild(close);
    btn.addEventListener("click", () => activateTab(path));
    logTabs.appendChild(btn);
  }
}

async function loadLogs(projectPath) {
  logBody.innerHTML = "";
  const text = await bridge.getLog(projectPath);
  if (state.activeTab !== projectPath) return;
  logBody.innerHTML = renderLogText(text);
  appendSeparator(`attached to ${tabName(projectPath)} at ${clock()}`);
  if (state.logFollow) logBody.scrollTop = logBody.scrollHeight;
}

function appendSeparator(text) {
  const div = document.createElement("div");
  div.className = "sep";
  div.textContent = "─ " + text + " ─";
  logBody.appendChild(div);
}

function appendLog(projectPath, chunk) {
  if (state.activeTab === projectPath) {
    const nearBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 60;
    const pre = document.createElement("pre");
    pre.style.cssText = "display:inline;font:inherit;";
    pre.innerHTML = renderLogText(chunk);
    logBody.appendChild(pre);
    if (state.logFollow && nearBottom) logBody.scrollTop = logBody.scrollHeight;
  } else if (state.tabs.has(projectPath)) {
    const t = state.tabs.get(projectPath);
    if (!t.hasNew) {
      t.hasNew = true;
      renderTabs();
    }
  }
}

// Clicking a log link opens the URL in the default browser instead of navigating the app away
logBody.addEventListener("click", (e) => {
  const a = e.target.closest("a.loglink");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  bridge.openUrl(a.href);
});

function saveLog() {
  if (!state.activeTab) return;
  const path = state.activeTab;
  bridge.getLog(path).then((text) => {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = tabName(path).replace(/\W+/g, "_") + "-log.txt";
    a.click();
    URL.revokeObjectURL(url);
    toast("Log saved", "info");
  });
}

$("btn-close-log").addEventListener("click", () => {
  logPanel.classList.add("hidden");
  render();
});

$("btn-clear-log").addEventListener("click", () => {
  logBody.innerHTML = "";
  if (state.activeTab) bridge.clearLog(state.activeTab);
});

$("btn-save-log").addEventListener("click", saveLog);

$("btn-follow").addEventListener("click", (e) => {
  state.logFollow = !state.logFollow;
  e.currentTarget.classList.toggle("active", state.logFollow);
  e.currentTarget.textContent = state.logFollow ? "⤓ follow" : "⤓ paused";
});

// ---------- header controls ----------
function rescan() {
  state.scanning = true;
  state.scanStart = Date.now();
  progressEl.classList.remove("hidden");
  setStatus("Scanning…");
  bridge.scan({ useCache: false });
}

$("btn-rescan").addEventListener("click", rescan);

$("btn-config").addEventListener("click", () => bridge.openConfig());

// ---------- new project dialog ----------
function openNewProjectDialog() {
  if (!state.createFolders.length) return;
  state.newProj.folder = state.createFolders[0];
  $("newproj-name").value = "";
  $("newproj-error").classList.add("hidden");
  renderFolderButtons();
  updatePathPreview();
  $("newproj-overlay").classList.remove("hidden");
  $("newproj-name").focus();
}

function renderFolderButtons() {
  const wrap = $("newproj-folders");
  wrap.innerHTML = "";
  for (const f of state.createFolders) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "folder-btn" + (f === state.newProj.folder ? " sel" : "");
    b.textContent = f;
    b.title = "Create in " + f;
    b.addEventListener("click", () => {
      state.newProj.folder = f;
      renderFolderButtons();
      updatePathPreview();
    });
    wrap.appendChild(b);
  }
}

// The folder that new projects are created under: first scan root + chosen folder
function newProjBase() {
  const root = state.scanRoots[0] || "";
  const folder = state.newProj.folder || "";
  return (root ? root.replace(/[\\/]+$/, "") + "\\" : "") + folder;
}

function updatePathPreview() {
  const name = $("newproj-name").value.trim();
  $("newproj-path").innerHTML = `${esc(newProjBase())}\\<b>${esc(name || "…")}</b>`;
}

function closeNewProjectDialog() {
  $("newproj-overlay").classList.add("hidden");
  $("btn-newproject").focus();
}

async function submitNewProject() {
  const nameInput = $("newproj-name");
  const name = nameInput.value.trim();
  const errEl = $("newproj-error");
  if (!name) {
    errEl.textContent = "Enter a project name.";
    errEl.classList.remove("hidden");
    nameInput.focus();
    return;
  }
  const btn = $("newproj-create");
  btn.disabled = true;
  btn.textContent = "Creating…";
  errEl.classList.add("hidden");
  try {
    const res = await bridge.createProject({ name, folder: state.newProj.folder });
    if (!res.ok) {
      errEl.textContent = res.message || "Could not create project.";
      errEl.classList.remove("hidden");
      return;
    }
    closeNewProjectDialog();
    // pin the new project to the top of "My order" and show it under the name the user typed
    state.customOrder = [res.path, ...state.customOrder.filter((p) => p !== res.path)];
    state.customNames[res.path] = res.name;
    bridge.updateConfig({ customOrder: state.customOrder, customNames: state.customNames });
    openTab(res.path);
    toast(`Created <b>${esc(res.name)}</b> in ${esc(res.folder)} — running on port <b>${res.port}</b>`, "success");
    rescan();
  } finally {
    btn.disabled = false;
    btn.textContent = "Create & Start";
  }
}

$("btn-newproject").addEventListener("click", openNewProjectDialog);
$("newproj-create").addEventListener("click", submitNewProject);
$("newproj-cancel").addEventListener("click", closeNewProjectDialog);
$("newproj-name").addEventListener("input", updatePathPreview);
$("newproj-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitNewProject();
  if (e.key === "Escape") closeNewProjectDialog();
});
$("newproj-overlay").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeNewProjectDialog();
});

// ---------- kill by port ----------
async function killByPort() {
  const input = $("portkill-input");
  const port = parseInt(input.value, 10);
  if (!(port > 0 && port <= 65535)) {
    toast("Enter a valid port (1–65535)", "error");
    input.focus();
    return;
  }
  const res = await bridge.killPort(port);
  if (!res.ok) {
    toast(res.message, "error");
    return;
  }
  if (res.users.length) {
    const names = res.users.map((u) => `PID ${u.pid}${u.name ? ` (${u.name})` : ""}`).join(", ");
    toast(`⚔ Port <b>${port}</b>: killed ${names}`, "success");
  } else {
    toast(`Port <b>${port}</b>: nothing listening`, "info");
  }
  if (res.output) setStatus(res.output.split("\r\n").filter(Boolean).join(" · "));
  input.value = "";
}

$("portkill-btn").addEventListener("click", killByPort);
$("portkill-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") killByPort();
});

$("btn-stopall").addEventListener("click", async () => {
  const res = await bridge.stopAll();
  toast(`Stopped ${res.stopped} project(s)`, "info");
});

filterEl.addEventListener("input", () => {
  state.filter = filterEl.value;
  render();
});

sortEl.addEventListener("change", () => {
  state.sort = sortEl.value;
  render();
});

function updateRunningUi() {
  runningPill.classList.toggle("hidden", state.runningCount === 0);
  runningCountEl.textContent = state.runningCount;
  stopAllBtn.classList.toggle("hidden", state.runningCount === 0);
}

// ---------- project list loading (cache-first) ----------
function populateProjects(projects) {
  const prev = new Set(state.projects.keys());
  state.projects.clear();
  for (const p of projects) state.projects.set(p.path, p);
  state.runningCount = [...state.projects.values()].filter((x) => x.status === "running" || x.status === "starting").length;
  updateRunningUi();
  return prev;
}

function openBootTabs() {
  if (state.bootTabsOpened) return;
  state.bootTabsOpened = true;
  for (const r of state.bootRunning) {
    if (!state.tabs.has(r.path)) state.tabs.set(r.path, { name: r.name || r.path.split(/[\\/]/).pop(), hasNew: false });
  }
  if (state.tabs.size) {
    logPanel.classList.remove("hidden");
    const last = [...state.tabs.keys()].pop();
    activateTab(last);
  }
}

bridge.onScanCached(({ projects, roots, scannedAt }) => {
  populateProjects(projects);
  rootsEl.textContent = roots.join("  ·  ");
  const ago = Math.max(1, Math.round((Date.now() - scannedAt) / 1000));
  const when = ago > 90 ? `${Math.round(ago / 60)}m` : `${ago}s`;
  setStatus(`Loaded ${projects.length} projects from cache (${when} old) — scanning for updates…`);
  openBootTabs();
  render();
});

bridge.onScanDone(({ projects, roots }) => {
  state.scanning = false;
  progressEl.classList.add("hidden");
  const prev = populateProjects(projects);
  rootsEl.textContent = roots.join("  ·  ");
  const secs = ((Date.now() - state.scanStart) / 1000).toFixed(1);

  if (state.firstListLoaded) {
    // background update — report what changed
    const fresh = new Set(state.projects.keys());
    const added = [...fresh].filter((k) => !prev.has(k));
    const removed = [...prev].filter((k) => !fresh.has(k));
    if (added.length) toast(`<b>${added.length}</b> new project(s): ${esc(added.map((a) => state.projects.get(a).name).join(", "))}`, "success");
    if (removed.length) toast(`${removed.length} project(s) no longer found`, "info");
  }
  state.firstListLoaded = true;

  setStatus(`${projects.length} bun projects${state.runningCount ? ` · ${state.runningCount} running` : ""} · scanned in ${secs}s`);
  openBootTabs();
  render();
});

// ---------- process events ----------
bridge.onProjectStatus(({ path, status, port, startedAt }) => {
  const p = state.projects.get(path);
  if (!p) return;
  p.status = status;
  if (port != null) p.port = port;
  if (startedAt) p.startedAt = startedAt;

  state.runningCount = [...state.projects.values()].filter((x) => x.status === "running" || x.status === "starting").length;
  updateRunningUi();
  patchRow(path);

  if (state.tabs.has(path)) renderTabs();
  if (state.expanded.size && (status === "running" || status === "stopped" || status === "error")) fillPortStatuses();
  if (state.expanded.size && status === "running") {
    // the server binds shortly after the process spawns — re-check a couple of times
    setTimeout(fillPortStatuses, 800);
    setTimeout(fillPortStatuses, 2600);
  }

  if (status === "running") {
    toast(`<b>${esc(displayName(path))}</b> running${p.port ? ` on port ${p.port}` : ""}`, "success");
  } else if (status === "error") {
    toast(`<b>${esc(displayName(path))}</b> failed to start`, "error");
  } else if (status === "stopped") {
    toast(`<b>${esc(displayName(path))}</b> stopped`, "info");
  }
});

bridge.onProjectLog(({ path, chunk }) => appendLog(path, chunk));

// ---------- boot ----------
(async () => {
  const cfg = await bridge.getConfig();
  if (cfg) {
    state.customNames = cfg.customNames || {};
    state.customOrder = cfg.customOrder || [];
    state.createFolders = cfg.createFolders || ["AI", "Dev", "gen"];
    state.scanRoots = cfg.scanRoots || [];
  }
  setStatus("Loading…");
  state.scanStart = Date.now();
  bridge.scan({ useCache: true }); // fires scan-cached instantly, then scan-done after the background scan
  const running = await bridge.getRunning();
  state.bootRunning = running;
  if (state.projects.size) openBootTabs();
})();
