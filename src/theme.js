import { invoke } from "@tauri-apps/api/core";
import { setEditorDark } from "./editor.js";
import { applyToAllTabs } from "./tabs.js";

// テーマ管理: html[data-theme] の切替 + CodeMirror の dark/light 極性 +
// ネイティブ側(メニューチェック・ウィンドウ chrome)の同期 + localStorage 永続化。
// テーマを追加するときは themes.css / lib.rs の theme_defs と合わせてここに1行足す。

const THEMES = [
  { id: "dark", dark: true },
  { id: "light", dark: false },
  { id: "solarized-dark", dark: true },
  { id: "solarized-light", dark: false },
];
const STORAGE_KEY = "mymemo.theme";
const find = (id) => THEMES.find((t) => t.id === id) ?? THEMES[0];

export function applyTheme(id) {
  const theme = find(id);
  document.documentElement.dataset.theme = theme.id;
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {}
  applyToAllTabs(setEditorDark(theme.dark));
  invoke("set_theme", { theme: theme.id, dark: theme.dark }).catch(console.error);
}

// 保存済みテーマの復元。エディタ生成(createView)より前に呼ぶこと
export function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {}
  const theme = find(saved);
  setEditorDark(theme.dark); // タブ未生成なので reconfigure は不要
  document.documentElement.dataset.theme = theme.id; // インラインスクリプトと冪等(不正値も正規化)
  invoke("set_theme", { theme: theme.id, dark: theme.dark }).catch(console.error);
}
