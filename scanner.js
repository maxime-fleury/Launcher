const fs = require("fs");
const path = require("path");
const { DEFAULTS } = require("./config");

// Port is looked up in this order of scripts
const SCRIPT_PRIORITY = ["dev", "start", "serve", "preview", "run", "start:dev", "dev:start", "build"];

// Patterns tried in order on each script string
const SCRIPT_PORT_PATTERNS = [
  /(?:^|[\s&|;])--?(?:port|server\.port)\s*[=:]\s*(\d{1,5})/i, // --port 3000, --port=3000, --server.port 8080
  /(?:^|[\s&|;])-p\s+(\d{1,5})\b/i, // -p 3000
  /(?:^|[\s;])PORT\s*=\s*(\d{1,5})/i, // PORT=3000
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0)[:/](\d{1,5})\b/i, // localhost:3000
  /listen\s*\(\s*(\d{1,5})/i, // listen(3000)
  /listen\s+on\s+(?:\S+:)?(\d{1,5})\b/i, // listening on 3000
];

// Strong patterns tried on source files (entry file, then followed imports)
const SOURCE_PORT_PATTERNS = [
  /\bport\s*:\s*["']?(\d{1,5})["']?/i, // Bun.serve({ port: 3001 }), config objects
  /(?:process|Bun|Deno)\.env\.\w*PORT\w*\s*(?:\|\|?|\?\?)\s*["']?(\d{1,5})/i, // process.env.PORT || 3000, Bun.env.PORT || "3000"
  /(?:const|let|var)\s+\w*PORT\w*\s*=\s*(?:parseInt|Number)\(\s*(?:process|Bun|Deno)\.env\.\w*PORT\w*\s*(?:\|\|?|\?\?)\s*["']?(\d{1,5})/i, // const PORT = parseInt(Bun.env.PORT || "3000")
  /\bport\s*:\s*(?:parseInt|Number)\(\s*(?:process|Bun|Deno)\.env\.\w*PORT\w*\s*(?:\|\|?|\?\?)\s*["']?(\d{1,5})/i, // port: Number(process.env.PORT ?? 3000)
  /(?:const|let|var)\s+\bPORT\w*\s*=\s*["']?(\d{1,5})["']?/i, // const PORT = 3000, const portRaw = 3000
  /findAvailablePort\(\s*(\d{1,5})/i, // findAvailablePort(3000, 3010)
  /\.listen\(\s*["']?(\d{1,5})/i, // Express/Elysia: .listen(3000)
];

// Known framework dev-server defaults (used when nothing explicit was found)
const FRAMEWORK_DEFAULTS = { vite: 5173, next: 3000, nuxt: 3000, svelte: 5173, solid: 5173 };

// Files worth following when the entry file's port is hidden behind an import
const IMPORT_PRIORITY = [
  (f) => /(env|config)/i.test(path.basename(f)) ? 0 : /(server|app|index|main)/i.test(path.basename(f)) ? 1 : 2,
];

const ENTRY_EXTENSIONS = [".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx"];

function validPort(n) {
  return n > 0 && n <= 65535;
}

function firstMatch(text, patterns) {
  if (!text) return null;
  for (const re of patterns) {
    const m = text.match(re);
    if (m && validPort(parseInt(m[1], 10))) return parseInt(m[1], 10);
  }
  return null;
}

function detectPortInScripts(scripts) {
  const names = [...SCRIPT_PRIORITY, ...Object.keys(scripts).sort()];
  for (const name of names) {
    const script = scripts[name];
    if (!script || typeof script !== "string") continue;
    const port = firstMatch(script, SCRIPT_PORT_PATTERNS);
    if (port) return port;
  }
  return null;
}

// First JS/TS entry file mentioned in a script segment ("bun run --watch src/index.ts" -> src/index.ts)
function extractEntryFile(script) {
  if (!script) return null;
  const m = script.match(/\bbun(?:\s+run)?\s+(?:(?:--\w+|\-[a-z])\s+)*([^\s&|;"']+\.(?:[cm]?[jt]sx?|js))\b/i);
  return m ? m[1] : null;
}

// Entry files referenced by the project's scripts (chains handled: "a && b" -> first segment that names a file)
function collectEntryFiles(projectDir, scripts) {
  const files = new Set();
  for (const name of SCRIPT_PRIORITY) {
    const script = scripts[name];
    if (!script || typeof script !== "string") continue;
    for (const seg of script.split(/\s*&&\s*/)) {
      const rel = extractEntryFile(seg);
      if (rel) files.add(path.resolve(projectDir, rel));
    }
  }
  // Vite-style projects
  for (const vc of ["vite.config.ts", "vite.config.js", "vite.config.mjs"]) {
    const p = path.join(projectDir, vc);
    if (fs.existsSync(p)) files.add(p);
  }
  return [...files];
}

// Resolve a relative import specifier to an existing file (tries extensions / index files)
function resolveRelative(baseFile, spec) {
  const base = path.resolve(path.dirname(baseFile), spec);
  const candidates = [base, ...ENTRY_EXTENSIONS.map((e) => base + e), ...ENTRY_EXTENSIONS.map((e) => path.join(base, "index" + e))];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep trying */
    }
  }
  return null;
}

function relativeImports(text) {
  const out = [];
  for (const m of text.matchAll(/(?:import\s+[^"']*?from\s*|require\s*\(\s*)["'](\.[^"']+)["']/g)) {
    out.push(m[1]);
  }
  return out;
}

// Weak last-resort guess: a 4-5 digit number that looks like a port, in a port-related context.
// Gates: the file mentions a port identifier somewhere; candidates are `return N` statements or
// numbers on lines that mention "port".
// words that contain "port" but are never about ports
const PORT_FALSE_WORDS = /report|support|important|airport|passport|transport|export|import|rapport|portfolio|opportunity|sport|deport|purport|resort|proportion|portion|porthole|porcelain|portal/i;

function mentionsPortIdentifier(text) {
  if (/\b(?:[Pp]ort|PORT)\b/.test(text)) return true;
  for (const m of text.matchAll(/(?:^|[^A-Za-z])(\w*[Pp]ort\w*)[^A-Za-z]/g)) {
    if (!PORT_FALSE_WORDS.test(m[1])) return true;
  }
  return false;
}

function weakPortGuess(text) {
  if (!text) return null;
  if (!mentionsPortIdentifier(text)) return null;

  const candidates = [];
  // explicit `return 3000;` / `=> 3000` in a port-aware file
  for (const m of text.matchAll(/(?:return|=>)\s+["']?(\d{1,5})["']?\s*[;,\n]/g)) {
    const n = parseInt(m[1], 10);
    if (validPort(n)) candidates.push(n);
  }
  // numbers on lines that mention port (comments like "port HTTP (défaut 3000)")
  if (!candidates.length) {
    for (const line of text.split("\n")) {
      if (!/\b(?:[Pp]ort|PORT)\b/.test(line)) continue;
      const m = line.match(/\b(10[2-9][4-9]|10[3-9]\d|1[1-9]\d{2}|[2-9]\d{3}|[1-5]\d{4}|6[0-5]\d{3})\b/);
      if (m) {
        candidates.push(parseInt(m[1], 10));
        break;
      }
    }
  }
  return candidates[0] || null;
}

// Detect the port a project listens on: strong patterns -> follow imports -> framework default -> guess
function detectPortInSource(projectDir, scripts, framework) {
  const startFiles = collectEntryFiles(projectDir, scripts);
  const read = (f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  };

  // BFS through the entry file and its env/config/server imports (bounded)
  const queue = [...startFiles];
  const seen = new Set();
  let followed = 0;
  const MAX_FOLLOW = 12;

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = read(file);
    if (!text) continue;

    const port = firstMatch(text, SOURCE_PORT_PATTERNS);
    if (port) return { port, source: file };

    if (followed < MAX_FOLLOW) {
      for (const spec of relativeImports(text)) {
        const resolved = resolveRelative(file, spec);
        if (resolved && !seen.has(resolved) && !queue.includes(resolved)) {
          queue.push(resolved);
          followed++;
        }
      }
      // env/config imports first, then server/app/index/main
      queue.sort((a, b) => IMPORT_PRIORITY[0](a) - IMPORT_PRIORITY[0](b));
    }
  }

  // Framework dev-server defaults
  if (framework && FRAMEWORK_DEFAULTS[framework]) {
    return { port: FRAMEWORK_DEFAULTS[framework], source: framework + " default" };
  }
  // vite may not be in deps but referenced by scripts
  const scriptText = Object.values(scripts || {}).join(" ");
  if (/\bvite\b/.test(scriptText)) return { port: 5173, source: "vite default" };

  // Gated guess over the entry files
  for (const f of startFiles) {
    const p = weakPortGuess(read(f));
    if (p) return { port: p, source: f + " (guessed)" };
  }
  return null;
}

function detectPort(scripts, projectDir, framework) {
  return detectPortInScripts(scripts) || detectPortInSource(projectDir, scripts, framework)?.port || null;
}

function pickScript(scripts) {
  for (const name of SCRIPT_PRIORITY) {
    if (scripts[name] && typeof scripts[name] === "string") return name;
  }
  return null;
}

// Best-effort framework detection from dependencies
const FRAMEWORK_RULES = [
  ["next", ["next"]],
  ["hono", ["hono"]],
  ["express", ["express"]],
  ["fastify", ["fastify"]],
  ["nuxt", ["nuxt"]],
  ["svelte", ["svelte", "@sveltejs/kit"]],
  ["solid", ["solid-js"]],
  ["vue", ["vue"]],
  ["vite", ["vite"]],
  ["react", ["react"]],
];

function detectFramework(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [label, keys] of FRAMEWORK_RULES) {
    if (keys.some((k) => deps[k])) return label;
  }
  return null;
}

// Directories (relative to the project) that typically hold a favicon, in priority order
const FAVICON_DIRS = ["", "public", "static", "assets", "src/assets", "client", "src"];

function findFavicon(dir) {
  for (const sub of FAVICON_DIRS) {
    const base = sub ? path.join(dir, sub) : dir;
    let entries;
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    // priority: favicon.* first, then apple-touch-icon, then icon.*
    const byKind = (re) => entries.find((e) => re.test(e));
    const hit =
      byKind(/^favicon\.(?:ico|png|svg|jpe?g|gif|webp)$/i) ||
      byKind(/^apple-touch-icon\.png$/i) ||
      byKind(/^icon\.(?:ico|png|svg|jpe?g|gif|webp)$/i);
    if (hit) return path.join(base, hit);
  }
  return null;
}

// Read package.json and describe a bun project found in `dir`
function describeProject(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const scripts = pkg.scripts || {};
    const framework = detectFramework(pkg);
    const port = detectPort(scripts, dir, framework);
    return {
      path: dir,
      name: pkg.name || path.basename(dir),
      script: pickScript(scripts) || "dev",
      port,
      description: pkg.description || "",
      framework,
      favicon: findFavicon(dir),
    };
  } catch {
    return null;
  }
}

// a script that invokes bun at a command position: "bun server.ts", "bun run dev", "bunx prettier"
const BUN_SCRIPT_RE = /(?:^|[\s;&|])(?:bun|bunx)\s+/;

function isBunProject(dir, pkgRaw) {
  try {
    if (!pkgRaw) pkgRaw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    if (
      fs.existsSync(path.join(dir, "bun.lock")) ||
      fs.existsSync(path.join(dir, "bun.lockb")) ||
      fs.existsSync(path.join(dir, "bunfig.toml"))
    ) {
      return true;
    }
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.packageManager === "string" && pkg.packageManager.startsWith("bun@")) return true;
    // no lock file committed, but the scripts clearly run bun
    if (pkg.scripts && typeof pkg.scripts === "object") {
      for (const v of Object.values(pkg.scripts)) {
        if (typeof v === "string" && BUN_SCRIPT_RE.test(v)) return true;
      }
    }
  } catch {
    /* unreadable */
  }
  return false;
}

/**
 * Recursively scan roots for bun projects.
 * Returns a promise of the project list; calls onProgress({scanned, found, currentDir}) periodically.
 */
async function scanForBunProjects(roots, { ignoredDirs = DEFAULTS.ignoredDirs, onProgress } = {}) {
  const ignore = new Set(ignoredDirs.map((d) => d.toLowerCase()));
  const projects = [];
  let scanned = 0;
  let lastProgress = Date.now();

  const queue = [...roots];
  const report = () => {
    const now = Date.now();
    if (onProgress && (now - lastProgress > 200 || queue.length === 0)) {
      lastProgress = now;
      onProgress({ scanned, found: projects.length, currentDir: queue[0] || "" });
    }
  };

  // Small worker pool; each worker pulls the next directory to inspect
  const worker = async () => {
    while (queue.length) {
      const dir = queue.shift();
      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable / missing
      }
      scanned++;
      report();

      const subdirs = [];
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue; // avoid junction/symlink cycles
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignore.has(entry.name.toLowerCase())) subdirs.push(full);
        } else if (entry.name === "package.json") {
          try {
            const raw = fs.readFileSync(full, "utf8");
            if (isBunProject(dir, raw)) {
              const p = describeProject(dir);
              if (p) projects.push(p);
            }
          } catch {
            /* broken package.json — ignore */
          }
        }
      }
      queue.push(...subdirs);
    }
  };

  const workers = Array.from({ length: 24 }, () => worker());
  await Promise.all(workers);
  report();

  projects.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return projects;
}

module.exports = { scanForBunProjects, detectPort, pickScript, isBunProject, detectFramework };
