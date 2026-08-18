// E2E: expanded details port status + kill-by-port input.
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

  await waitFor("document.querySelectorAll('.row').length > 0 ? true : false", "rows", 15);

  // expand first row (coinpusher, port 3001) -> port status should say "free"
  await evalJs("document.querySelector('.row .chevron').click()");
  await waitFor("document.querySelector('.portline') ? document.querySelector('.portline').textContent !== 'checking…' : false", "portline filled", 10);
  console.log("[1] port status (before start):", await evalJs("document.querySelector('.portline').textContent + ' [' + document.querySelector('.portline').className + ']'"));

  // start coinpusher, wait running, then portline should say "in use"
  await evalJs("document.querySelector('.row .btn.start.primary').click()");
  await waitFor("document.querySelector('.row .statuslabel') && document.querySelector('.row .statuslabel').textContent === 'RUNNING' ? true : false", "RUNNING", 20);
  await sleep(1500); // let fillPortStatuses refresh
  console.log("[2] port status (running):", await evalJs("document.querySelector('.portline').textContent + ' [' + document.querySelector('.portline').className + ']'"));

  // kill by port 3001 via the input
  await evalJs(`(() => { const i = document.getElementById('portkill-input'); i.value = '3001'; document.getElementById('portkill-btn').click(); return true; })()`);
  await sleep(2500);
  console.log("[3] after kill, status label:", await evalJs("document.querySelector('.row .statuslabel') ? document.querySelector('.row .statuslabel').textContent : '(none)'"));
  console.log("[3] port status (after kill):", await evalJs("document.querySelector('.portline') ? document.querySelector('.portline').textContent + ' [' + document.querySelector('.portline').className + ']' : 'n/a'"));

  // kill on an empty port -> "nothing listening"
  await evalJs(`(() => { const i = document.getElementById('portkill-input'); i.value = '39999'; document.getElementById('portkill-btn').click(); return true; })()`);
  await sleep(1500);
  console.log("[3] empty-port toast:", await evalJs("document.querySelector('#toasts .toast:last-child') ? document.querySelector('#toasts .toast:last-child').textContent : 'none'"));

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
