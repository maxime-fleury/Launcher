# 🟤 Bun Launcher

Desktop app (Electron) that scans your drives for **bun projects** and starts them with one click.
Before starting a project it automatically runs your `kpport` tool to kill whatever is using the
project's port, so you never get "port already in use".

## Run

Fastest ways to open it (no terminal needed):

- **Desktop shortcut** — double-click **Bun Launcher** on your Desktop.
- **`Bun Launcher.vbs`** in this folder — double-click, no console flash.
- **`launcher.cmd`** in this folder.

From a terminal you can also use:

```bash
cd D:\Launcher
npm start
```

If you move the folder, recreate the desktop shortcut with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\make-desktop-shortcut.ps1
```

A window opens, scans the configured roots, and lists every project that has a `package.json`
together with `bun.lock` / `bun.lockb` (or `packageManager: "bun@…"`).

### Controls

- **Click a project** → kills its port (kpport) then runs `bun run dev` (or `start`) in that folder.
- **Click again / ■ Stop** → kills the process tree. **⟳** restarts a running project.
- **🔗 :PORT** badge → opens `http://localhost:PORT` in your browser (lights up green while running).
- **▸** chevron → expand details (folder, script, framework, port, description).
- **⎇** → opens a **terminal tab** for that project in the bottom panel. Run several projects and
  switch between their consoles with tabs (status dot, new-output indicator, ✕ closes the tab
  without stopping the process; tabs survive stops so you can read the final output).
- Tab toolbar: auto-scroll follow toggle, **💾 Save** to file, Clear, hide panel.
- **⚔ Kill by port** — a port input in the bottom status bar: type a port, hit Kill, and it runs
  `kpport` on it. It first shows what's using the port (PID + process name), then kills it,
  with a toast like “Port 3001: killed PID 22364 (bun.exe)”.
- **Port status** — expanding a project with a detected port shows whether that port is currently
  **in use** (by whom) or **free**.
- **✎ Rename** — hover a project and click the ✎ to give it a custom display name
  (Enter saves, Esc cancels, empty reverts to the package name). Names follow the project
  everywhere, including terminal tabs.
- **Reorder that survives rescans** — **My order** is the default view. Click **📌** on any
  project to pin it to the top, or drag rows (⋮⋮ handle) to arrange them freely.
  The order is saved in `config.json` and reapplies after every rescan/restart.
  Other sort views (running first / name / port) are one click away.
- **Favicons** — projects with a `favicon.*` (or `apple-touch-icon.png` / `icon.*`)
  in their root, `public/`, `static/`, `assets/` or `src/` show it next to their name
  and on their terminal tab.
- **⧉ copy path** button in the expanded details.
- **＋ New Project** — opens a dialog: type a name, pick a folder (**AI / Dev / gen**), and hit **Create & Start**.
  It creates `<root>\<folder>\<name>` with a minimal bun project (`package.json` + `src/index.ts`),
  installs `@types/bun`, picks the **first free port from 3000 to 3600**, and starts it right away.
  The generated server itself prefers 3000 and walks up to 3600 at runtime if that port is taken.
  The chosen port is saved as a `portOverride` so the launcher always starts/opens the right one.
- **⟳ Rescan**, **■ Stop all**, sort dropdown (running first / my order / name / port), and search by name/path/port.
- Running projects show a green **RUNNING** badge, live **uptime**, and their detected port.
- Framework badges (vite / hono / express / next / react / svelte / …) are detected from dependencies.
- Toast notifications confirm starts, stops, restarts, failures, and list changes.

### Scan cache

The last scan is stored in `cache.json`. On launch the app shows the cached list **instantly**, scans
the drives in the background, and then updates the list in place — new projects are added with a
toast, removed ones disappear. A manual **⟳ Rescan** always does a fresh scan.

## Config (`config.json`)

| Key | Meaning |
|---|---|
| `scanRoots` | Folders scanned recursively (default `["D:\\"]`). |
| `kpportPath` | Path to `kpport.cmd` (default `C:\tools\kpport.cmd`). |
| `bunPath` | Fallback bun executable if `bun` isn't on PATH. |
| `ignoredDirs` | Directory names never entered (node_modules, .git, venv, …). |
| `createFolders` | Folder names offered by **＋ New Project** (default `["AI", "Dev", "gen"]`), created under the first scan root. |
| `portOverrides` | Project path → port, for projects the auto-detection misses: |

```json
"portOverrides": {
  "D:\\Dev\\YouFind": 3000,
  "D:\\AI\\Lumiverse": 8080
}
```

## Port detection

The port is detected automatically, in layers:

1. **Scripts** — `--port 3000`, `PORT=3000`, `-p 3000`, `localhost:3000`, …
2. **Source files** — `Bun.serve({ port: 3001 })`, `process.env.PORT || 3000`,
   `parseInt(Bun.env.PORT || "3000")`, `port: Number(process.env.PORT ?? 3000)`,
   `findAvailablePort(3000, …)`, `app.listen(3000)`, `vite.config` `port:` values.
3. **Followed imports** — if the port lives in an imported file, the scanner follows the
   entry's `env`/`config`/`server`/`app`/`main` imports (bounded) to find it
   (e.g. `config.server.port`, `require('./search/server')`, `env.ts`).
4. **Framework defaults** — vite/svelte → 5173, next/nuxt → 3000.
5. **Gated guess** — as a last resort, a 4-5 digit number in a port-related context
   (`return 3000;` in a port function, “port … 3000” in comments), guarded against
   false words (report, export, transport, …).

Anything it still can't find goes in `portOverrides`.

## CLI scan

```bash
npm run scan            # uses config.json roots
node scripts/scan-cli.js "D:\AI" "D:\Dev"   # custom roots
```
