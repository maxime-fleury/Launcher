// E2E smoke test against a running launcher (electron --remote-debugging-port=9222).
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
  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");

  // wait for scan to finish
  for (let i = 0; i < 30; i++) {
    const n = await evalJs("document.querySelectorAll('.row').length");
    if (n > 0) break;
    await sleep(1000);
  }
  console.log("[1] rows:", await evalJs("document.querySelectorAll('.row').length"));
  console.log("[1] statusbar:", await evalJs("document.getElementById('statusbar').textContent"));
  console.log("[1] frameworks:", await evalJs("Array.from(new Set(Array.from(document.querySelectorAll('.badge.fw')).map(b=>b.textContent))).join(',')"));

  const clicked = await evalJs(`(() => {
    const b = document.querySelector('.row .btn.start.primary');
    if (!b) return 'no start button';
    const name = b.closest('.row').querySelector('.name-text').textContent;
    b.click();
    return 'clicked ' + name;
  })()`);
  console.log("[2]", clicked);

  // wait for RUNNING on the first row
  let state = "";
  for (let i = 0; i < 25; i++) {
    state = await evalJs("document.querySelector('.row .statuslabel') ? document.querySelector('.row .statuslabel').textContent : ''");
    if (state === "RUNNING") break;
    await sleep(1000);
  }
  console.log("[3] status:", state);
  console.log("[3] statuses in state:", await evalJs("JSON.stringify([...state.projects.values()].map(p=>({n:p.name,s:p.status,st:p.startedAt?1:0})))"));
  console.log("[3] uptime:", await evalJs("document.querySelector('.row .uptime') ? document.querySelector('.row .uptime').textContent : 'none'"));
  console.log("[3] port badge live:", await evalJs("!!document.querySelector('.row .badge.port.live')"));
  console.log("[3] restart btn visible:", await evalJs("!document.querySelector('.row .btn.ghost.tiny.rowbtn:not(.hidden)') ? 'n/a' : !!Array.from(document.querySelectorAll('.row .rowbtn')).find(b=>b.textContent==='⟳' && !b.classList.contains('hidden'))"));
  console.log("[3] running count:", await evalJs("document.getElementById('runningcount').textContent"));
  console.log("[3] logs tail:", JSON.stringify(await evalJs("document.getElementById('logbody').textContent.slice(-160)")));

  // stop it
  await evalJs("document.querySelector('.row .btn.start').click()");
  await sleep(2500);
  console.log("[4] after stop:", await evalJs("document.querySelector('.row .statuslabel') ? document.querySelector('.row .statuslabel').textContent : '(none)'"));
  console.log("[4] running count:", await evalJs("document.getElementById('runningcount').textContent"));

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
