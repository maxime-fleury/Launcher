// Standalone CLI: node scripts/scan-cli.js [root...]
// Scans the given roots (default: config scanRoots) and prints found bun projects.
const { scanForBunProjects } = require("../scanner");
const { loadConfig } = require("../config");

(async () => {
  const config = loadConfig();
  const roots = process.argv.slice(2).length ? process.argv.slice(2) : config.scanRoots;

  console.log(`Scanning ${roots.join(", ")} ...`);
  const projects = await scanForBunProjects(roots, {
    ignoredDirs: config.ignoredDirs,
    onProgress: (p) => process.stdout.write(`\r\x1b[K  ${p.scanned} dirs scanned, ${p.found} projects found`),
  });

  process.stdout.write("\r\x1b[K");
  console.log(`\nFound ${projects.length} bun projects:\n`);
  for (const p of projects) {
    console.log(`  ${p.name.padEnd(28)} port=${p.port ?? "n/a"}  ${p.script.padEnd(6)}  ${p.path}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
