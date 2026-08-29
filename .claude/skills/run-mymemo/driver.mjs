#!/usr/bin/env node
// mymemo のフロントエンドを Chrome(headless, CDP)で駆動するドライバ。依存パッケージなし(Node 22+ の組み込み WebSocket / fetch)。
// Tauri の IPC(window.__TAURI_INTERNALS__)をモックし、read_file / write_file / grep_search は Node 側の fs にブリッジする。
// ネイティブメニューは plugin:event|listen に登録されたハンドラを直接呼んで再現する(`menu <id>`)。
//
// 使い方(リポジトリ直下で):
//   node .claude/skills/run-mymemo/driver.mjs <<'EOF'
//   open /tmp/a.txt
//   type hello
//   ss /tmp/shot.png
//   EOF
// 1 行 1 コマンド。`help` で一覧。stdin が閉じるとブラウザと vite を終了する。

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHROME =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_DEV = process.env.MYMEMO_URL ?? "http://localhost:1420/";
const VIEW = { width: 1100, height: 750 };

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- vite
async function reachable(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureVite() {
  if (await reachable(URL_DEV)) {
    log(`# vite: 既に ${URL_DEV} が応答しているので再利用`);
    return null;
  }
  const bin = path.join(ROOT, "node_modules/.bin/vite");
  const p = spawn(bin, ["--port", "1420", "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    if (await reachable(URL_DEV)) {
      log(`# vite: 起動 (pid ${p.pid})`);
      return p;
    }
    if (p.exitCode !== null) throw new Error(`vite が終了しました:\n${out}`);
    await sleep(200);
  }
  p.kill();
  throw new Error(`vite が 20 秒以内に応答しませんでした:\n${out}`);
}

// ---------------------------------------------------------------- chrome + CDP
async function launchChrome() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "mymemo-chrome-"));
  const p = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      `--window-size=${VIEW.width},${VIEW.height}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const wsUrl = await new Promise((resolve, reject) => {
    let err = "";
    p.stderr.on("data", (d) => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    p.on("exit", (c) => reject(new Error(`Chrome が終了しました (code ${c}):\n${err}`)));
    setTimeout(() => reject(new Error(`Chrome の DevTools が 15 秒以内に起動しませんでした:\n${err}`)), 15000);
  });
  const port = new URL(wsUrl).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("page ターゲットが見つかりません");
  return { proc: p, profile, pageWs: page.webSocketDebuggerUrl };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
      } else {
        this.handlers.get(msg.method)?.(msg.params);
      }
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    return new CDP(ws);
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    this.handlers.set(method, fn);
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text);
    }
    return r.result.value;
  }
}

// ---------------------------------------------------------------- Tauri IPC モック(ページ内で実行される)
function mockInit() {
  const callbacks = new Map(); // transformCallback の id → fn
  const listeners = new Map(); // event 名 → Map(id → fn)
  const pending = new Map(); // bridge 要求 id → {resolve, reject}
  let next = 1;
  const calls = [];
  const dialog = { open: null, confirm: true, save: null };

  const bridge = (cmd, args) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      window.__mymemoBridge(JSON.stringify({ id, cmd, args }));
    });
  window.__mymemoBridgeResult = (id, ok, value) => {
    const p = pending.get(id);
    pending.delete(id);
    ok ? p.resolve(value) : p.reject(value);
  };
  const emit = (event, payload) => {
    const m = listeners.get(event);
    if (!m) return 0;
    for (const [id, fn] of m) fn({ event, id, payload });
    return m.size;
  };

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
      windows: [{ label: "main" }],
      webviews: [{ label: "main", windowLabel: "main" }],
    },
    transformCallback(cb) {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args = {}) {
      if (!cmd.startsWith("plugin:event|")) calls.push({ cmd, args });
      switch (cmd) {
        case "plugin:event|listen": {
          if (!listeners.has(args.event)) listeners.set(args.event, new Map());
          listeners.get(args.event).set(args.handler, callbacks.get(args.handler));
          return args.handler;
        }
        case "plugin:event|unlisten":
          listeners.get(args.event)?.delete(args.eventId);
          return;
        case "plugin:event|emit":
        case "plugin:event|emit_to":
          emit(args.event, args.payload);
          return;
        case "set_theme":
        case "set_show_whitespace":
        case "set_line_wrap":
        case "set_recent_files":
        case "set_indent":
        case "popup_status_menu":
          return null;
        case "take_pending_open_files":
          // 起動と同時に Finder から渡されたファイル(モックでは常に無し)。
          // 起動後に渡される経路は `emit open-files ["<path>"]` で再現できる
          return [];
        case "plugin:dialog|message": {
          // plugin-dialog の confirm()/ask() も message コマンドに buttons 付きで来て、
          // 戻り値は押されたボタンのラベル文字列("Ok"/"Yes" など)。真偽値ではないので注意
          const b = args.buttons;
          if (!b || b === "Ok") return null;
          if (typeof b === "object") return dialog.confirm ? b.ok ?? b.yes : b.cancel ?? b.no;
          return dialog.confirm ? (b === "YesNo" ? "Yes" : "Ok") : b === "YesNo" ? "No" : "Cancel";
        }
        case "plugin:dialog|open":
          return dialog.open;
        case "save_dialog_with_options":
          return dialog.save;
        case "quit_app":
          window.__mymemoQuit = true;
          return null;
        case "read_file":
        case "write_file":
        case "file_mtime":
        case "grep_search":
        case "grep_replace":
          return bridge(cmd, args);
        default:
          throw new Error(`mock: 未対応コマンド ${cmd}`);
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event, id) {
      listeners.get(event)?.delete(id);
    },
  };
  // CodeMirror の EditorView を DOM から取り出す(6.x 系で cmTile / 旧版で cmView と名前が違う)
  const view = () => {
    const c = document.querySelector(".cm-content");
    return c?.cmTile?.root?.view ?? c?.cmView?.rootView?.view ?? null;
  };
  window.__mymemo = { emit, calls, dialog, listeners, view };
}

// ---------------------------------------------------------------- ブリッジ(Node 側の実装)
const DECODER_LABEL = {
  "UTF-8": "utf-8",
  CP932: "shift_jis",
  "EUC-JP": "euc-jp",
  "UTF-16LE": "utf-16le",
  "UTF-16BE": "utf-16be",
};

function decode(buf, encoding) {
  if (!encoding) {
    if (buf[0] === 0xff && buf[1] === 0xfe) encoding = "UTF-16LE";
    else if (buf[0] === 0xfe && buf[1] === 0xff) encoding = "UTF-16BE";
    else {
      try {
        return { content: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "UTF-8", lossy: false };
      } catch {
        encoding = "CP932"; // 簡易判定。本物の判定は Rust 側(cargo test で確認)
      }
    }
  }
  const label = DECODER_LABEL[encoding];
  if (!label) throw new Error(`mock: 未対応の文字コード ${encoding}`);
  const content = new TextDecoder(label).decode(buf);
  return { content, encoding, lossy: content.includes("�") };
}

function encode(content, encoding) {
  if (encoding === "UTF-8") return Buffer.from(content, "utf8");
  if (encoding === "UTF-16LE") return Buffer.from(content, "utf16le");
  if (encoding === "UTF-16BE") return Buffer.from(content, "utf16le").swap16();
  throw new Error(`mock: ${encoding} の書き込みは未対応(Rust 側の cargo test で確認すること)`);
}

function grepRegExp(args) {
  const src = args.isRegex ? args.pattern : args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(src, args.caseSensitive ? "" : "i");
}

// "*.md" "!skip.txt" "src/**/*.js" 形式の簡易 glob(ignore クレートの override に相当)。
// "/" を含まないパターンはファイル名だけに、含むものはルートからの相対パスに当てる。後勝ち
function globFilter(globs = []) {
  const rules = globs.map((g) => {
    const neg = g.startsWith("!");
    const pat = neg ? g.slice(1) : g;
    const src = pat
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\0/g, ".*");
    return { neg, re: new RegExp(`^${src}$`), anchored: pat.includes("/") };
  });
  const hasWhitelist = rules.some((r) => !r.neg);
  return (rel) => {
    let hit = null;
    for (const r of rules) if (r.re.test(r.anchored ? rel : rel.split("/").pop())) hit = r;
    return hit ? !hit.neg : !hasWhitelist;
  };
}

async function collectFiles(root, dir, filter, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if ([".git", "node_modules", "target", "dist"].includes(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collectFiles(root, p, filter, out);
    else if (e.isFile() && filter(path.relative(root, p))) out.push(p);
  }
}

async function grepDir(dir, re, hits, limit, filter = () => true, root = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if ([".git", "node_modules", "target", "dist"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (await grepDir(p, re, hits, limit, filter, root)) return true;
      continue;
    }
    if (!e.isFile() || !filter(path.relative(root, p))) continue;
    const text = new TextDecoder("utf-8").decode(await fs.readFile(p));
    const lines = text.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ path: p, line_number: i + 1, line_text: lines[i] });
        if (hits.length >= limit) return true;
      }
    }
  }
  return false;
}

// ファイルの更新時刻(UNIX ミリ秒)。無ければ null(Rust 側の mtime_of と同じ契約)
async function mtimeOf(p) {
  try {
    return Math.round((await fs.stat(p)).mtimeMs);
  } catch {
    return null;
  }
}

async function handleBridge(cmd, args) {
  switch (cmd) {
    case "read_file":
      return { ...decode(await fs.readFile(args.path), args.encoding ?? null), mtime: await mtimeOf(args.path) };
    case "write_file":
      await fs.writeFile(args.path, encode(args.content, args.encoding));
      return mtimeOf(args.path);
    case "file_mtime":
      return mtimeOf(args.path);
    case "grep_search": {
      const hits = [];
      const truncated = await grepDir(args.dir, grepRegExp(args), hits, 1000, globFilter(args.globs), args.dir);
      return { hits, truncated };
    }
    case "grep_replace": {
      // 簡易版: UTF-8 として読み書きし、JS の replace で置換する(文字コード保持は Rust 側の cargo test で確認)
      const re = new RegExp(grepRegExp(args).source, (args.caseSensitive ? "" : "i") + "g");
      const filter = globFilter(args.globs);
      const paths = [];
      await collectFiles(args.dir, args.dir, filter, paths);
      let files = 0;
      let replacements = 0;
      for (const p of paths) {
        const text = await fs.readFile(p, "utf8");
        let n = 0;
        const out = text.replace(re, (...m) => {
          n++;
          return args.isRegex ? args.replacement.replace(/\$(\d+|&)/g, (_, g) => (g === "&" ? m[0] : m[Number(g)] ?? "")) : args.replacement;
        });
        if (n) {
          await fs.writeFile(p, out);
          files++;
          replacements += n;
        }
      }
      return { files, replacements };
    }
  }
  throw new Error(`bridge: 未対応 ${cmd}`);
}

// ---------------------------------------------------------------- 入力ヘルパ
const KEYS = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  Tab: { code: "Tab", vk: 9, text: "\t" },
  Escape: { code: "Escape", vk: 27 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  Space: { code: "Space", vk: 32, text: " ", key: " " },
};
const MOD = { Alt: 1, Ctrl: 2, Control: 2, Meta: 4, Cmd: 4, Shift: 8 };

async function pressKey(cdp, combo) {
  const parts = combo.split("+");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MOD)) throw new Error(`不明な修飾キー ${m}`);
    modifiers |= MOD[m];
  }
  const def = KEYS[keyName];
  const key = def?.key ?? (def ? keyName : keyName);
  const code = def?.code ?? (/^[a-z]$/i.test(keyName) ? `Key${keyName.toUpperCase()}` : /^[0-9]$/.test(keyName) ? `Digit${keyName}` : keyName);
  const vk = def?.vk ?? (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0);
  const text = modifiers & ~MOD.Shift ? undefined : def?.text ?? (keyName.length === 1 ? keyName : undefined);
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function typeText(cdp, text) {
  // フォーカス中の要素(grep の input など)があればそこへ、無ければエディタへ入力する
  await cdp.eval(`if (!document.activeElement || document.activeElement === document.body) document.querySelector(".cm-content").focus()`);
  const chunks = text.replace(/\\n/g, "\n").split("\n");
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i]) await cdp.send("Input.insertText", { text: chunks[i] });
    if (i < chunks.length - 1) await pressKey(cdp, "Enter");
  }
}

async function click(cdp, selector) {
  const rect = await cdp.eval(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error("not found: ${selector}"); el.scrollIntoView({block:"nearest"}); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`
  );
  const base = { x: rect.x, y: rect.y, button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

async function waitFor(cdp, expr, ms = 5000, what = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await cdp.eval(`!!(${expr})`)) return;
    await sleep(50);
  }
  throw new Error(`タイムアウト(${ms}ms): ${what}`);
}

const JS_DOC = `window.__mymemo.view().state.doc.toString()`;
const JS_TABS = `[...document.querySelectorAll("#tabbar .tab")].map(t => (t.classList.contains("active") ? "* " : "  ") + t.querySelector(".tab-name").textContent + (t.classList.contains("dirty") ? " (dirty)" : "") + "  [" + t.title + "]").join("\\n")`;

// ---------------------------------------------------------------- コマンド
const HELP = `コマンド一覧(1 行 1 コマンド):
  open <path>                 ファイルを開く(dialog open + menu open を経由。実ファイルを読む)
  drop <path>                 ドラッグ&ドロップで開く(tauri://drag-drop を発火)
  type <text>                 フォーカス中の要素に入力(\\n で改行)。何もフォーカスしていなければエディタへ
  key <combo>                 キー入力: Enter / Backspace / ArrowLeft / Meta+z / Shift+ArrowRight / a など
  click <selector>            要素の中心をクリック
  menu <id>                   ネイティブメニュー相当: new open save save_as close_tab find grep toggle_whitespace quit theme:<id> open_enc:<enc>
  dialog open <path|null>     次の「開く」ダイアログの戻り値
  dialog confirm <true|false> 次の確認ダイアログの戻り値
  dialog save <path> [enc] [KEEP|LF|CRLF|CR]  次の保存パネルの戻り値
  save                        menu save + 保存完了(dirty 解除)を待つ
  saveas <path> [enc] [eol]   dialog save + menu save_as + 完了待ち
  doc                         エディタ本文を表示
  tabs                        タブ一覧(* がアクティブ、dirty 表示)
  status                      ステータスバー
  text <selector>             要素の textContent
  eval <js>                   ページ内で評価(await 可)。window.__mymemo.view() で EditorView、.calls/.dialog にモック内部
  calls                       モックが受けた invoke の一覧を表示してクリア
  emit <event> <json>         任意の Tauri イベントを発火
  ss <file.png>               スクリーンショット
  wait <ms> / waitfor <selector> [ms]
  quit                        終了`;

async function runCommand(ctx, line) {
  const { cdp } = ctx;
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = line.trim().slice(cmd.length).trim();
  switch (cmd) {
    case "":
    case "#":
      return;
    case "help":
      return log(HELP);
    case "open": {
      const p = path.resolve(arg);
      await cdp.eval(`window.__mymemo.dialog.open = ${JSON.stringify(p)}; window.__mymemo.emit("menu", "open")`);
      await waitFor(cdp, `document.querySelector("#tabbar .tab.active")?.title === ${JSON.stringify(p)}`, 5000, `タブ ${p} が開く`);
      return log(await cdp.eval(JS_TABS));
    }
    case "drop": {
      const p = path.resolve(arg);
      await cdp.eval(`window.__mymemo.emit("tauri://drag-drop", { paths: [${JSON.stringify(p)}], position: { x: 0, y: 0 } })`);
      await waitFor(cdp, `document.querySelector("#tabbar .tab.active")?.title === ${JSON.stringify(p)}`, 5000, `タブ ${p} が開く`);
      return log(await cdp.eval(JS_TABS));
    }
    case "type":
      return typeText(cdp, arg);
    case "key":
      return pressKey(cdp, arg);
    case "click":
      return click(cdp, arg);
    case "menu": {
      const n = await cdp.eval(`window.__mymemo.emit("menu", ${JSON.stringify(arg)})`);
      if (!n) log(`!! menu リスナーが登録されていません`);
      await sleep(100);
      return;
    }
    case "dialog": {
      const [kind, ...v] = rest;
      let value;
      if (kind === "open") value = v[0] === "null" ? null : path.resolve(v[0]);
      else if (kind === "confirm") value = v[0] !== "false";
      else if (kind === "save") value = v[0] === "null" ? null : { path: path.resolve(v[0]), encoding: v[1] ?? "UTF-8", line_ending: v[2] ?? "KEEP" };
      else throw new Error(`dialog の種類は open / confirm / save`);
      return cdp.eval(`window.__mymemo.dialog[${JSON.stringify(kind)}] = ${JSON.stringify(value)}`);
    }
    case "save":
      await cdp.eval(`window.__mymemo.emit("menu", "save")`);
      await waitFor(cdp, `!document.querySelector("#tabbar .tab.active")?.classList.contains("dirty")`, 5000, "保存完了");
      return log(await cdp.eval(JS_TABS));
    case "saveas": {
      const [p, enc, eol] = rest;
      await runCommand(ctx, `dialog save ${p} ${enc ?? "UTF-8"} ${eol ?? "KEEP"}`);
      await cdp.eval(`window.__mymemo.emit("menu", "save_as")`);
      await waitFor(cdp, `document.querySelector("#tabbar .tab.active")?.title === ${JSON.stringify(path.resolve(p))} && !document.querySelector("#tabbar .tab.active").classList.contains("dirty")`, 5000, "別名保存完了");
      return log(await cdp.eval(JS_TABS));
    }
    case "doc":
      return log(await cdp.eval(JS_DOC));
    case "tabs":
      return log(await cdp.eval(JS_TABS));
    case "status":
      return log(await cdp.eval(`document.querySelector("#statusbar").textContent.replace(/\\s+/g, " ").trim()`));
    case "text":
      return log(await cdp.eval(`document.querySelector(${JSON.stringify(arg)})?.textContent ?? "(not found)"`));
    case "eval": {
      const v = await cdp.eval(arg);
      return log(v === undefined ? "undefined" : JSON.stringify(v, null, 1));
    }
    case "calls": {
      const v = await cdp.eval(`(() => { const c = window.__mymemo.calls.splice(0); return c; })()`);
      return log(JSON.stringify(v));
    }
    case "emit": {
      const [ev, ...json] = rest;
      return log(`listeners: ` + (await cdp.eval(`window.__mymemo.emit(${JSON.stringify(ev)}, ${json.join(" ") || "null"})`)));
    }
    case "ss": {
      const r = await cdp.send("Page.captureScreenshot", { format: "png" });
      const out = path.resolve(arg);
      await fs.writeFile(out, Buffer.from(r.data, "base64"));
      return log(`screenshot: ${out}`);
    }
    case "wait":
      return sleep(Number(arg));
    case "waitfor":
      return waitFor(cdp, `document.querySelector(${JSON.stringify(rest[0])})`, Number(rest[1] ?? 5000), rest[0]);
    case "quit":
      ctx.quit = true;
      return;
    default:
      throw new Error(`不明なコマンド: ${cmd}(help で一覧)`);
  }
}

// ---------------------------------------------------------------- main
async function main() {
  const vite = await ensureVite();
  const chrome = await launchChrome();
  const cdp = await CDP.connect(chrome.pageWs);
  const ctx = { cdp, quit: false };
  const cleanup = async () => {
    try { chrome.proc.kill(); } catch {}
    if (vite) try { vite.kill(); } catch {}
    await fs.rm(chrome.profile, { recursive: true, force: true }).catch(() => {});
  };
  process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await cdp.send("Runtime.addBinding", { name: "__mymemoBridge" });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(${mockInit.toString()})()` });
    cdp.on("Runtime.bindingCalled", async ({ name, payload }) => {
      if (name !== "__mymemoBridge") return;
      const { id, cmd, args } = JSON.parse(payload);
      let ok = true, value;
      try {
        value = await handleBridge(cmd, args);
      } catch (e) {
        ok = false;
        value = String(e.message ?? e);
      }
      await cdp.eval(`window.__mymemoBridgeResult(${id}, ${ok}, ${JSON.stringify(value ?? null)})`);
    });
    cdp.on("Runtime.consoleAPICalled", ({ type, args }) => {
      if (type === "error" || type === "warning") log(`# console.${type}:`, args.map((a) => a.value ?? a.description).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => log(`# page exception:`, d.exception?.description ?? d.text));

    await cdp.send("Page.navigate", { url: URL_DEV });
    await waitFor(cdp, `document.querySelector(".cm-content") && window.__mymemo.listeners.has("menu")`, 15000, "アプリの初期化(.cm-content と menu リスナー)");
    log(`# ready: ${URL_DEV} (viewport ${VIEW.width}x${VIEW.height})`);

    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    for await (const line of rl) {
      if (ctx.quit) break;
      log(`> ${line}`);
      try {
        await runCommand(ctx, line);
      } catch (e) {
        log(`!! ${e.message ?? e}`);
      }
      if (ctx.quit) break;
    }
  } finally {
    await cleanup();
  }
}

main().catch(async (e) => {
  console.error(`!! ${e.stack ?? e}`);
  process.exit(1);
});
