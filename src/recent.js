import { invoke } from "@tauri-apps/api/core";

// 最近使ったファイル: 開いた・保存したファイルのパスを新しい順に保持し、
// localStorage に永続化してネイティブメニュー(ファイル > 最近使ったファイルを開く)へ反映する。
// メニュー項目の作り直しは Rust 側(set_recent_files)で行う

const STORAGE_KEY = "mymemo.recentFiles";
export const MAX_RECENT = 10;

let recent = [];

// path を先頭に移し(重複は除く)、max 件に切り詰めた新しい配列を返す
export function pushRecent(list, path, max = MAX_RECENT) {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

export function getRecentFiles() {
  return recent.slice();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
  } catch {}
  invoke("set_recent_files", { paths: recent }).catch(console.error);
}

export function addRecentFile(path) {
  recent = pushRecent(recent, path);
  persist();
}

// 開けなくなったファイルなどを履歴から外す
export function removeRecentFile(path) {
  if (!recent.includes(path)) return;
  recent = recent.filter((p) => p !== path);
  persist();
}

export function clearRecentFiles() {
  recent = [];
  persist();
}

// 保存済み履歴の復元(壊れていれば空)。メニューにも反映する
export function initRecentFiles() {
  let saved = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) saved = parsed.filter((p) => typeof p === "string");
  } catch {}
  recent = saved.slice(0, MAX_RECENT);
  persist();
}
