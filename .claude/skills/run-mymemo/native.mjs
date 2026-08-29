#!/usr/bin/env node
// 本物の Tauri アプリ(debug ビルド)を `npm run tauri dev` で起動し、ウィンドウ領域のスクリーンショットを撮って終了する。
// macOS 専用(osascript / screencapture を使う)。フロントの操作は driver.mjs の方が確実なので、こちらは
// 「ネイティブメニュー・ウィンドウ・Rust コマンドを含めて実際に起動できるか」の確認用。
//
// 使い方: node .claude/skills/run-mymemo/native.mjs [--shot out.png] [--type "text"] [--keep]
//   --shot  ウィンドウ領域を PNG に保存
//   --type  System Events でキー入力(アクセシビリティ権限が必要)。入力ソースが日本語だと IME を通って
//           かな変換されるので、文字列の検証には使わず「キー入力が届くか」の確認に留める
//   --keep  終了せずに起動したままにする(pid を表示。止めるときは pkill -x mymemo)

import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ウィンドウ出現前は System Events が -1728 を返すので stderr は捨てる(呼び出し側で再試行する)
const osa = (script) =>
  execFileSync("osascript", ["-e", script], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const pgrep = () => {
  try {
    return execFileSync("pgrep", ["-x", "mymemo"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

if (pgrep().length) {
  console.error("!! mymemo が既に起動しています。pkill -x mymemo で止めてから実行してください");
  process.exit(1);
}

let log = "";
const dev = spawn("npm", ["run", "tauri", "dev"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));

const t0 = Date.now();
let pids = [];
while (!(pids = pgrep()).length) {
  if (dev.exitCode !== null) {
    console.error(`!! tauri dev が終了しました (code ${dev.exitCode}):\n${log}`);
    process.exit(1);
  }
  if (Date.now() - t0 > 300000) {
    console.error(`!! 5 分待ってもアプリが起動しません:\n${log.slice(-2000)}`);
    dev.kill();
    process.exit(1);
  }
  await sleep(500);
}
console.log(`# mymemo 起動 (pid ${pids.join(",")}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ウィンドウが出るまで待つ
let bounds = null;
for (let i = 0; i < 60 && !bounds; i++) {
  try {
    const r = osa('tell application "System Events" to tell process "mymemo" to get {position, size} of window 1');
    bounds = r.split(",").map((n) => parseInt(n.trim(), 10));
  } catch {
    await sleep(500);
  }
}
if (!bounds) {
  console.error("!! ウィンドウが見つかりません(System Events の権限を確認)");
} else {
  console.log(`# window: x=${bounds[0]} y=${bounds[1]} w=${bounds[2]} h=${bounds[3]}`);
  osa('tell application "System Events" to set frontmost of process "mymemo" to true');
  await sleep(500);
}

const text = opt("--type");
if (text) {
  osa(`tell application "System Events" to keystroke ${JSON.stringify(text)}`);
  await sleep(300);
  console.log(`# typed: ${text}`);
}

const shot = opt("--shot");
if (shot && bounds) {
  const out = path.resolve(shot);
  execFileSync("screencapture", ["-x", "-R", bounds.join(","), out]);
  console.log(`screenshot: ${out}`);
}

if (args.includes("--keep")) {
  console.log(`# --keep: 起動したままにします。止めるには: pkill -x mymemo`);
  dev.unref();
  dev.stdout.destroy();
  dev.stderr.destroy();
  process.exit(0);
}

// 終了: アプリを止めると tauri CLI が vite も道連れに終了する
execFileSync("pkill", ["-x", "mymemo"]);
for (let i = 0; i < 20 && dev.exitCode === null; i++) await sleep(500);
if (dev.exitCode === null) {
  console.log("# tauri dev が残っているので kill します");
  dev.kill("SIGTERM");
}
console.log(`# 終了 (tauri dev exit=${dev.exitCode})`);
