const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "config.json");

const DEFAULTS = {
  // Folders to scan recursively for bun projects
  scanRoots: ["D:\\"],
  // Path to the kpport.cmd that kills whatever listens on a port
  kpportPath: "C:\\tools\\kpport.cmd",
  // Fallback bun executable (used if 'bun' is not on PATH)
  bunPath: "C:\\Users\\Max\\.bun\\bin\\bun",
  // Directory names that are never descended into
  ignoredDirs: [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "venv",
    ".venv",
    "env",
    "dist",
    "build",
    "out",
    "target",
    "__pycache__",
    ".cache",
    ".next",
    ".nuxt",
    ".turbo",
    ".idea",
    ".vscode",
    "coverage",
    ".parcel-cache",
    ".svelte-kit",
    "bin",
    "obj",
    "$RECYCLE.BIN",
    "System Volume Information",
  ],
  // Folder names offered in the "New Project" dialog (created under scanRoots[0])
  createFolders: ["AI", "Dev", "gen"],
  // Project path -> port, for projects whose port can't be detected from scripts
  portOverrides: {},
  // Project path -> custom display name (rename in the launcher)
  customNames: {},
  // Project paths in the user's custom display order (drag & drop)
  customOrder: [],
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULTS,
      ...raw,
      portOverrides: { ...DEFAULTS.portOverrides, ...(raw.portOverrides || {}) },
      customNames: { ...(raw.customNames || {}) },
      customOrder: Array.isArray(raw.customOrder) ? raw.customOrder : [],
    };
  } catch {
    saveConfig(DEFAULTS);
    return { ...DEFAULTS, portOverrides: { ...DEFAULTS.portOverrides } };
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH, DEFAULTS };
