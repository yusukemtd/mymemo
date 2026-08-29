import { invoke } from "@tauri-apps/api/core";
import { setLineWrap } from "./editor.js";
import { applyToAllTabs } from "./tabs.js";

// 行の折り返し切替: CodeMirror 拡張の有効/無効 +
// ネイティブメニューのチェック状態の同期 + localStorage 永続化(既定は折り返さない)

const STORAGE_KEY = "mymemo.lineWrap";
let wrapped = false;

export function isLineWrap() {
  return wrapped;
}

export function applyLineWrap(wrap) {
  wrapped = wrap;
  try {
    localStorage.setItem(STORAGE_KEY, wrap ? "1" : "0");
  } catch {}
  applyToAllTabs(setLineWrap(wrap));
  invoke("set_line_wrap", { wrap }).catch(console.error);
}

export function toggleLineWrap() {
  applyLineWrap(!wrapped);
}

// 保存済み設定の復元。エディタ生成(createView)より前に呼ぶこと
export function initLineWrap() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {}
  wrapped = saved === "1";
  setLineWrap(wrapped); // タブ未生成なので reconfigure は不要
  invoke("set_line_wrap", { wrap: wrapped }).catch(console.error);
}
