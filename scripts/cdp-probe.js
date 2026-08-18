// Debug helper: connects to an Electron app launched with --remote-debugging-port=9222
// and reports what the UI actually shows.
const http = require("http");
const WebSocket = require("ws");

const PORT = process.argv[2] || 9222;

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
  if (!page) {
    console.log("NO PAGE TARGET", targets.map((t) => t.type));
    process.exit(1);
  }
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

  await new Promise((r) => ws.on("open", r));
  await send("Runtime.enable");
  await new Promise((r) => setTimeout(r, 500));

  const exprs = {
    "status bar": "document.getElementById('statusbar').textContent",
    "row count": "document.querySelectorAll('.row').length",
    "window.api?": "typeof window.api",
    "first rows": "Array.from(document.querySelectorAll('.row')).slice(0,5).map(r=>r.querySelector('.name').textContent).join(' | ')",
    "body head": "document.body.innerText.slice(0, 300)",
  };
  for (const [label, expr] of Object.entries(exprs)) {
    const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    console.log(`[${label}]`, JSON.stringify(res.result?.result?.value ?? res));
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
