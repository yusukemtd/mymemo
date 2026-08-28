import { invoke } from "@tauri-apps/api/core";
import { setShowWhitespace } from "./editor.js";
import { applyToAllTabs } from "./tabs.js";

// 空白文字・改行の表示切替: CodeMirror 拡張の有効/無効 +
// ネイティブメニューのチェック状態の同期 + localStorage 永続化(既定は表示)。
// 可視化そのもの(記号の描画)は editor.js / style.css 側にある

const STORAGE_KEY = "mymemo.showWhitespace";
let shown = true;

export function isShowWhitespace() {
  return shown;
}

export function applyShowWhitespace(show) {
  shown = show;
  try {
    localStorage.setItem(STORAGE_KEY, show ? "1" : "0");
  } catch {}
  applyToAllTabs(setShowWhitespace(show));
  invoke("set_show_whitespace", { show }).catch(console.error);
}

export function toggleShowWhitespace() {
  applyShowWhitespace(!shown);
}

// 保存済み設定の復元。エディタ生成(createView)より前に呼ぶこと
export function initShowWhitespace() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {}
  shown = saved !== "0";
  setShowWhitespace(shown); // タブ未生成なので reconfigure は不要
  invoke("set_show_whitespace", { show: shown }).catch(console.error);
}
