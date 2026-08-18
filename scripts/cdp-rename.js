// E2E: favicon rendering, inline rename, drag & drop reorder.
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

  // --- favicon ---
  console.log("[1] favicons rendered:", await evalJs(`(() => {
    const imgs = Array.from(document.querySelectorAll('.row .fav'));
    return imgs.map(i => ({ name: i.closest('.row').querySelector('.name-text').textContent, loaded: i.naturalWidth > 0 }));
  })()`));

  // --- rename coinpusher ---
  await evalJs(`(() => {
    const row = Array.from(document.querySelectorAll('.row')).find(r => r.querySelector('.name-text').textContent === 'coinpusher');
    row.querySelector('.rename-btn').click();
    const input = row.querySelector('.rename-input');
    input.value = 'Coin Pusher Pro';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  console.log("[2] renamed row shows:", await evalJs(`(() => {
    const row = Array.from(document.querySelectorAll('.row')).find(r => r.querySelector('.name-text').textContent === 'Coin Pusher Pro');
    return row ? row.querySelector('.name-text').textContent : 'NOT FOUND';
  })()`));

  // --- reorder: switch to My order, drag first row onto 3rd row ---
  await evalJs(`(() => {
    const s = document.getElementById('sort');
    s.value = 'custom';
    s.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(300);
  const before = await evalJs("Array.from(document.querySelectorAll('.row .name-text')).slice(0,4).map(e=>e.textContent)");
  console.log("[2] order before drag:", before.join(' | '));
  await evalJs(`(() => {
    const rows = document.querySelectorAll('.row');
    const src = rows[0], dst = rows[3];
    const dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  })()`);
  await sleep(700);
  const after = await evalJs("Array.from(document.querySelectorAll('.row .name-text')).slice(0,4).map(e=>e.textContent)");
  console.log("[2] order after drag:", after.join(' | '));

  // --- persistence ---
  const cfg = JSON.parse(fs.readFileSync("D:/Launcher/config.json", "utf8"));
  console.log("[3] config.customNames:", JSON.stringify(cfg.customNames));
  console.log("[3] config.customOrder (first 2):", JSON.stringify(cfg.customOrder.slice(0, 2)));

  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
