const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const { execFile, spawn } = require("child_process");
const { scanForBunProjects } = require("./scanner");
const { loadConfig, saveConfig, CONFIG_PATH } = require("./config");

let mainWindow = null;
let config = loadConfig();

// projectPath -> { child, script, port, status, name, startedAt }
const running = new Map();
// projectPath -> chunk[] — log history kept even after the process stops (for terminal tabs)
const logBuffers = new Map();
const LOG_LIMIT = 4000;
const LOG_BUFFER_LIMIT = 30; // keep recent buffers for stopped projects

const SCAN_CACHE_PATH = path.join(__dirname, "cache.json");

// New projects are served on the first free port in this range (the generated template also retries at runtime)
const NEW_PROJECT_PORT_MIN = 3000;
const NEW_PROJECT_PORT_MAX = 3600;

const isWindows = process.platform === "win32";

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 800,
    minHeight: 500,
    title: "Bun Launcher",
    backgroundColor: "#14161a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --- kpport: kill whatever is listening on `port` ---
function runKpport(port, capture = false) {
  const kpportPath = config.kpportPath;
  if (!kpportPath || !port) return capture ? Promise.resolve("") : Promise.resolve();
  return new Promise((resolve) => {
    execFile("cmd.exe", ["/c", kpportPath, String(port)], { windowsHide: true }, (err, stdout, stderr) => {
      if (capture) resolve((stdout || "") + (stderr || ""));
      else resolve();
    });
  });
}

// Who is listening on `port` right now? [{ pid, name }]
function getPortUsers(port) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const pids = new Set();
      const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(re);
        if (m) pids.add(m[1]);
      }
      const users = [...pids].map((pid) => ({ pid, name: "" }));
      if (!users.length) return resolve(users);
      let pending = users.length;
      for (const u of users) {
        execFile("tasklist", ["/FI", `PID eq ${u.pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (_e, out) => {
          const m = out.match(/"([^"]+)"/);
          u.name = m ? m[1] : "";
          if (--pending === 0) resolve(users);
        });
      }
    });
  });
}

// First free port in [min, max], from a single netstat snapshot. Returns null if none are free.
function getFirstFreePort(min, max) {
  return new Promise((resolve) => {
    execFile("netstat", ["-ano"], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(min);
      const busy = new Set();
      const re = /:(\d{1,5})\s+\S+\s+LISTENING\s+\d+\s*$/gim;
      for (const m of stdout.matchAll(re)) busy.add(parseInt(m[1], 10));
      for (let p = min; p <= max; p++) if (!busy.has(p)) return resolve(p);
      resolve(null);
    });
  });
}

// --- process management ---
function findBun() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (bin) => {
      if (!done) {
        done = true;
        resolve(bin);
      }
    };
    const trySpawn = (bin) => {
      const child = spawn(bin, ["--version"], { windowsHide: true, stdio: "ignore" });
      child.on("error", () => finish(null));
      child.on("spawn", () => {
        child.kill();
        finish(bin);
      });
    };
    trySpawn("bun");
    setTimeout(() => finish(null), 3000); // safety net
  });
}

let bunBin = null;
(async () => {
  bunBin = await findBun();
  if (bunBin) console.log(`[launcher] using bun at ${bunBin}`);
  else console.warn("[launcher] bun not found on PATH; projects may fail to start");
})();

const ts = () => new Date().toLocaleTimeString([], { hour12: false });

function setStatus(projectPath, status, extra = {}) {
  const entry = running.get(projectPath);
  if (entry) {
    entry.status = status;
    Object.assign(entry, extra);
  }
  send("project-status", { path: projectPath, status, startedAt: entry?.startedAt ?? null, ...extra });
}

function pushLog(projectPath, chunk) {
  let buf = logBuffers.get(projectPath);
  if (!buf) {
    buf = [];
    logBuffers.set(projectPath, buf);
    if (logBuffers.size > LOG_BUFFER_LIMIT) {
      const oldest = logBuffers.keys().next().value;
      logBuffers.delete(oldest);
    }
  }
  buf.push(chunk);
  if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT);
  send("project-log", { path: projectPath, chunk });
}

async function startProject(projectPath, project, { skipKill = false } = {}) {
  if (running.has(projectPath) && running.get(projectPath).child) {
    return { ok: true, alreadyRunning: true };
  }

  const port = (config.portOverrides && config.portOverrides[projectPath]) || project.port || null;
  const script = project.script || "dev";
  const startedAt = Date.now();
  const entry = { child: null, script, port, status: "starting", name: project.name || path.basename(projectPath), startedAt };
  running.set(projectPath, entry);
  setStatus(projectPath, "starting", { port, script });

  // 1) free the port, then 2) start (skipKill: fresh projects already chose a free port — don't kill anything)
  if (port && !skipKill) {
    pushLog(projectPath, `[${ts()}] [launcher] killing anything on port ${port} (kpport)...\n`);
    await runKpport(port);
    pushLog(projectPath, `[${ts()}] [launcher] port ${port} clear.\n`);
  }

  const bin = bunBin || "bun";
  const child = spawn(bin, ["run", script], { cwd: projectPath, windowsHide: false });
  entry.child = child;

  child.stdout.on("data", (d) => pushLog(projectPath, d.toString()));
  child.stderr.on("data", (d) => pushLog(projectPath, d.toString()));
  child.on("spawn", () => {
    setStatus(projectPath, "running", { port, script, startedAt });
  });
  child.on("error", (err) => {
    pushLog(projectPath, `[${ts()}] [launcher] failed to start: ${err.message}\n`);
    setStatus(projectPath, "error", { error: err.message });
  });
  child.on("exit", (code, signal) => {
    if (running.get(projectPath)?.child === child) {
      pushLog(projectPath, `\n[${ts()}] [process exited] code=${code} signal=${signal}\n`);
      running.delete(projectPath);
      send("project-status", { path: projectPath, status: "stopped" });
    }
  });

  return { ok: true };
}

function stopProject(projectPath) {
  const entry = running.get(projectPath);
  if (!entry || !entry.child) return { ok: false, message: "not running" };
  const pid = entry.child.pid;
  entry.child.removeAllListeners("exit");
  entry.child.kill();
  if (isWindows) {
    // kill the whole process tree (bun run spawns a real child)
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
  pushLog(projectPath, `\n[${ts()}] [launcher] stopping...\n`);
  running.delete(projectPath);
  send("project-status", { path: projectPath, status: "stopped" });
  return { ok: true };
}

function loadScanCache() {
  try {
    const c = JSON.parse(fs.readFileSync(SCAN_CACHE_PATH, "utf8"));
    if (Array.isArray(c.projects) && Array.isArray(c.roots)) return c;
  } catch {
    /* no cache yet */
  }
  return null;
}

function saveScanCache(roots, projects) {
  try {
    const slim = projects.map(({ path: p, name, script, port, description, framework }) => ({
      path: p,
      name,
      script,
      port,
      description,
      framework,
    }));
    fs.writeFileSync(SCAN_CACHE_PATH, JSON.stringify({ scannedAt: Date.now(), roots, projects: slim }, null, 2));
  } catch {
    /* cache is best-effort */
  }
}

function mergeStatusAndOverrides(projects) {
  return projects.map((p) => {
    const ov = config.portOverrides && config.portOverrides[p.path];
    const run = running.get(p.path);
    return {
      ...p,
      port: ov ?? p.port,
      portOverridden: ov != null,
      faviconUrl: p.favicon ? pathToFileURL(p.favicon).href : null,
      status: run ? run.status : "stopped",
      startedAt: run?.startedAt ?? null,
    };
  });
}

// --- IPC ---
ipcMain.handle("scan", async (_e, { useCache } = {}) => {
  const roots = config.scanRoots || [];
  // fast path: serve the cached list immediately, then scan in the background
  if (useCache !== false) {
    const cache = loadScanCache();
    if (cache && JSON.stringify(cache.roots) === JSON.stringify(roots)) {
      send("scan-cached", { projects: mergeStatusAndOverrides(cache.projects), roots, scannedAt: cache.scannedAt });
    }
  }
  const projects = await scanForBunProjects(roots, {
    ignoredDirs: config.ignoredDirs,
    onProgress: (p) => send("scan-progress", p),
  });
  saveScanCache(roots, projects);
  const list = mergeStatusAndOverrides(projects);
  send("scan-done", { projects: list, roots });
  return { projects: list, roots };
});

ipcMain.handle("start-project", async (_e, projectPath) => {
  const cached = await scanForBunProjects([projectPath], { ignoredDirs: config.ignoredDirs });
  const project = cached[0];
  if (!project) return { ok: false, message: "project not found" };
  return startProject(projectPath, project);
});

ipcMain.handle("stop-project", (_e, projectPath) => stopProject(projectPath));

ipcMain.handle("restart-project", async (_e, projectPath) => {
  stopProject(projectPath);
  const cached = await scanForBunProjects([projectPath], { ignoredDirs: config.ignoredDirs });
  const project = cached[0];
  if (!project) return { ok: false, message: "project not found" };
  return startProject(projectPath, project);
});

// --- new project creation ---
// package.json for a minimal bun project (name = the project folder, kebab-cased)
function makePackageJson(pkgName) {
  return JSON.stringify(
    {
      name: pkgName,
      version: "0.1.0",
      private: true,
      description: "",
      scripts: {
        dev: "bun run --watch src/index.ts",
      },
      devDependencies: {
        "@types/bun": "latest",
      },
    },
    null,
    2
  );
}

// Server that starts on the first free port between 3000 and 3600 (3000 preferred).
function makeServerTemplate(pkgName) {
  return `const NAME = "${pkgName}";
const MIN_PORT = ${NEW_PROJECT_PORT_MIN};
const MAX_PORT = ${NEW_PROJECT_PORT_MAX};

function handler(req) {
  return new Response(\`Hello from \${NAME}! 🟤\`);
}

// Starts on 3000 by default; if that's taken it walks up to 3600 for a free port.
function findAvailablePort(start, end) {
  for (let port = start; port <= end; port++) {
    try {
      return Bun.serve({ port, fetch: handler });
    } catch {
      console.log(\`  port \${port} busy — trying \${port + 1}…\`);
    }
  }
  return null;
}

const server = findAvailablePort(${NEW_PROJECT_PORT_MIN}, ${NEW_PROJECT_PORT_MAX});
if (!server) {
  console.error(\`No free port between \${MIN_PORT} and \${MAX_PORT} — giving up.\`);
  process.exit(1);
}
console.log(\`🟤 \${NAME} running → http://localhost:\${server.port}\`);
`;
}

ipcMain.handle("create-project", async (_e, { name, folder } = {}) => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { ok: false, message: "Enter a project name." };
  if (trimmed.length > 60) return { ok: false, message: "Project name is too long (max 60 characters)." };
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed) || /[. ]$/.test(trimmed)) {
    return { ok: false, message: "Name contains characters Windows won't allow in a folder." };
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(trimmed)) {
    return { ok: false, message: "That name is reserved by Windows." };
  }

  const roots = config.scanRoots || [];
  if (!roots.length) return { ok: false, message: "No scan root configured (config.json scanRoots)." };
  const base = path.join(roots[0], String(folder || ""));
  const projectPath = path.join(base, trimmed);
  if (fs.existsSync(projectPath)) return { ok: false, message: `"${projectPath}" already exists.` };

  const port = await getFirstFreePort(NEW_PROJECT_PORT_MIN, NEW_PROJECT_PORT_MAX);
  if (!port) return { ok: false, message: `No free port between ${NEW_PROJECT_PORT_MIN} and ${NEW_PROJECT_PORT_MAX}.` };

  const pkgName =
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || trimmed.toLowerCase();

  try {
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, "package.json"), makePackageJson(pkgName), "utf8");
    fs.writeFileSync(path.join(projectPath, "src", "index.ts"), makeServerTemplate(pkgName), "utf8");
    fs.writeFileSync(path.join(projectPath, ".gitignore"), "node_modules\ndist\n.env\n", "utf8");
  } catch (err) {
    return { ok: false, message: `Could not create project: ${err.message}` };
  }

  // Remember the chosen port so the launcher starts/UI use the right one (scanner only sees the 3000 default)
  config.portOverrides[projectPath] = port;
  saveConfig(config);

  // Best-effort: install @types/bun so the editor has types + bun.lock exists for the scanner
  const bin = bunBin || config.bunPath || "bun";
  await new Promise((resolve) =>
    execFile(bin, ["install"], { cwd: projectPath, windowsHide: true, timeout: 30000 }, (err) => resolve())
  );

  const project = { path: projectPath, name: pkgName, script: "dev", port, description: "", framework: null };
  const started = await startProject(projectPath, project, { skipKill: true });
  return { ok: true, path: projectPath, port, folder: String(folder || ""), name: trimmed, ...started };
});

ipcMain.handle("stop-all", () => {
  const paths = [...running.keys()];
  for (const p of paths) stopProject(p);
  return { ok: true, stopped: paths.length };
});

ipcMain.handle("kill-port", async (_e, port) => {
  port = parseInt(port, 10);
  if (!(port > 0 && port <= 65535)) return { ok: false, message: "invalid port" };
  const users = await getPortUsers(port);
  const output = await runKpport(port, true);
  return { ok: true, port, users, output: (output || "").trim() };
});

ipcMain.handle("port-status", async (_e, port) => {
  port = parseInt(port, 10);
  if (!(port > 0 && port <= 65535)) return { inUse: false, users: [] };
  const users = await getPortUsers(port);
  return { inUse: users.length > 0, users };
});

ipcMain.handle("get-log", (_e, projectPath) => logBuffers.get(projectPath)?.join("") || "");

ipcMain.handle("clear-log", (_e, projectPath) => {
  logBuffers.delete(projectPath);
  return { ok: true };
});

ipcMain.handle("get-running", () =>
  [...running.entries()].map(([p, e]) => ({ path: p, name: e.name, status: e.status, port: e.port, script: e.script, startedAt: e.startedAt }))
);

ipcMain.handle("open-config", () => shell.openPath(path.dirname(CONFIG_PATH)));
ipcMain.handle("open-project-folder", (_e, projectPath) => shell.openPath(projectPath));
ipcMain.handle("open-url", (_e, url) => shell.openExternal(url));

ipcMain.handle("reload-config", () => {
  config = loadConfig();
  return config;
});

ipcMain.handle("get-config", () => config);

ipcMain.handle("update-config", (_e, partial) => {
  config = { ...config, ...partial };
  saveConfig(config);
  return config;
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // kill everything we started before quitting
  for (const entry of running.values()) {
    if (entry.child) {
      entry.child.removeAllListeners("exit");
      if (isWindows) execFile("taskkill", ["/pid", String(entry.child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else entry.child.kill();
    }
  }
  running.clear();
  if (!isWindows) app.quit();
  else app.quit();
});
