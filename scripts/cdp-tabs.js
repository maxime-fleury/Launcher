// E2E for terminal tabs: start 2 projects, check tabs, switch, stop all.
const http = require("http");
const WebSocket = require("ws");

const PORT = process.argv[2] || 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(JSON.parse(data)));
    }).on("error", reject);
  });
}

async function main() {
  const targets = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expression) => {
    const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };
  const waitFor = async (expr, label, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      const v = await evalJs(expr);
      if (v) return v;
      await sleep(1000);
    }
    console.log(`  TIMEOUT waiting for ${label}`);
    return null;
  };
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");

  console.log("[1] statusbar:", await waitFor("document.getElementById('statusbar').textContent && document.getElementById('statusbar').textContent.includes('bun projects') ? document.getElementById('statusbar').textContent : ''", "list", 15));
  console.log("[1] rows:", await evalJs("document.querySelectorAll('.row').length"));

  // start first project (coinpusher)
  await evalJs(`(() => { const b = document.querySelector('.row .btn.start.primary'); const n = b.closest('.row').querySelector('.name-text').textContent; b.click(); return n; })()`);
  await waitFor("document.querySelector('.row .statuslabel') && document.querySelector('.row .statuslabel').textContent === 'RUNNING' ? true : false", "coinpusher RUNNING", 20);
  console.log("[2] first started, tabs:", await evalJs("document.querySelectorAll('.ltab').length"));

  // start second project (companyfinder)
  await evalJs(`(() => { const rows = document.querySelectorAll('.row'); for (const r of rows) { const b = r.querySelector('.btn.start.primary'); if (b) { b.click(); return r.querySelector('.name-text').textContent; } } return 'none'; })()`);
  await waitFor("document.querySelectorAll('.ltab').length >= 2 ? true : false", "2 tabs", 20);
  console.log("[2] second started, tabs:", await evalJs("document.querySelectorAll('.ltab').length"));
  console.log("[2] running count:", await evalJs("document.getElementById('runningcount').textContent"));

  // active tab = second project; switch to first
  console.log("[3] active tab:", await evalJs("document.querySelector('.ltab.active .tname').textContent"));
  await evalJs(`(() => { const tabs = document.querySelectorAll('.ltab'); tabs[0].click(); })()`);
  await sleep(600);
  console.log("[3] after switch, active tab:", await evalJs("document.querySelector('.ltab.active .tname').textContent"));
  const logFirst = await evalJs("document.getElementById('logbody').textContent.slice(-120)");
  console.log("[3] log tail (first tab):", JSON.stringify(logFirst));

  // stop everything
  await evalJs("document.getElementById('btn-stopall').click()");
  await sleep(3000);
  console.log("[4] running count after stop-all:", await evalJs("document.getElementById('runningcount').textContent"));
  console.log("[4] tabs still present:", await evalJs("document.querySelectorAll('.ltab').length"));
  console.log("[4] first tab dot class:", await evalJs("document.querySelector('.ltab .tdot').className"));

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
