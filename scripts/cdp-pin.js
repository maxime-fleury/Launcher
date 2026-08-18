// E2E: pin-to-top + persistence across rescan.
const http = require("http");
const WebSocket = require("ws");
const fs = require("fs");

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

  console.log("[1] default sort:", await evalJs("document.getElementById('sort').value"));
  const firstNames = () => evalJs("Array.from(document.querySelectorAll('.row .name-text')).slice(0,3).map(e=>e.textContent)");
  console.log("[1] first 3:", (await firstNames()).join(' | '));

  // pin youfind
  await evalJs(`(() => {
    const row = Array.from(document.querySelectorAll('.row')).find(r => r.querySelector('.name-text').textContent === 'youfind');
    row.querySelector('.pinbtn').click();
    return true;
  })()`);
  await sleep(600);
  console.log("[2] after pin, first 3:", (await firstNames()).join(' | '));

  // rescan
  await evalJs("document.getElementById('btn-rescan').click()");
  await waitFor("document.getElementById('statusbar').textContent.includes('bun projects') ? true : false", "rescan done", 20);
  await sleep(500);
  console.log("[3] after rescan, first 3:", (await firstNames()).join(' | '));

  // persistence in config
  const cfg = JSON.parse(fs.readFileSync("D:/Launcher/config.json", "utf8"));
  console.log("[3] config.customOrder[0]:", cfg.customOrder[0]);

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
