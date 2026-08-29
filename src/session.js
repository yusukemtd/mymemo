import * as Tabs from "./tabs.js";

// セッション復元: 開いていたタブ(パス・文字コード・カーソル位置)と無題タブの下書き(本文)を
// localStorage に保存し、次回起動時に復元する。
// 保存のタイミングは、タブ・本文・カーソルの変化から 1 秒後(デバウンス)と終了の直前。
// パス付きタブの未保存の編集は保存しない(終了時に破棄の確認をする)。無題タブは本文ごと保存する

const STORAGE_KEY = "mymemo.session";
const VERSION = 1;
const SAVE_DELAY = 1000;

// タブ一覧を保存用の plain object にする。空の無題タブは残さない
export function snapshotSession(tabs, activeIndex, stateOf) {
  const entries = [];
  let active = -1;
  tabs.forEach((tab, i) => {
    const state = stateOf(tab);
    const draft = tab.path ? null : state.doc.toString();
    if (!tab.path && draft === "") return;
    if (i === activeIndex) active = entries.length;
    const { anchor, head } = state.selection.main;
    entries.push({ path: tab.path, encoding: tab.encoding, draft, cursor: { anchor, head } });
  });
  if (active < 0) active = entries.length - 1;
  return { version: VERSION, active, tabs: entries };
}

// 保存された JSON を検証して返す(無い・壊れている・別バージョンなら null)
export function parseSession(json) {
  if (!json) return null;
  let data;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || data.version !== VERSION || !Array.isArray(data.tabs)) return null;
  const tabs = data.tabs
    .filter((e) => e && (typeof e.path === "string" || typeof e.draft === "string"))
    .map((e) => ({
      path: typeof e.path === "string" ? e.path : null,
      encoding: typeof e.encoding === "string" ? e.encoding : "UTF-8",
      draft: typeof e.path === "string" ? null : e.draft,
      cursor: {
        anchor: Number.isInteger(e.cursor?.anchor) ? e.cursor.anchor : 0,
        head: Number.isInteger(e.cursor?.head) ? e.cursor.head : 0,
      },
    }));
  const active = Number.isInteger(data.active)
    ? Math.min(Math.max(data.active, 0), tabs.length - 1)
    : tabs.length - 1;
  return { version: VERSION, active, tabs };
}

// 現在の状態を保存する。localStorage に書けなかった(容量超過など)場合は false
export function saveSession() {
  const tabs = Tabs.getTabs();
  const snap = snapshotSession(tabs, tabs.indexOf(Tabs.getActiveTab()), Tabs.stateOf);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
    return true;
  } catch (err) {
    console.error("セッションを保存できませんでした", err);
    return false;
  }
}

let timer = null;
export function scheduleSaveSession() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    saveSession();
  }, SAVE_DELAY);
}

export function loadSession() {
  let json = null;
  try {
    json = localStorage.getItem(STORAGE_KEY);
  } catch {}
  return parseSession(json);
}

// 保存されたセッションからタブを作り直し、復元したタブ数を返す。
// readFile(path, encoding) は { content, encoding } を返す関数(読めないファイルは黙って飛ばす)。
// 文字コードは自動判定で読む(保存された encoding は「文字コードを変換」で保存前に変えた値かもしれず、
// それで読み直すと文字化けするため使わない)
export async function restoreSession(readFile, session = loadSession()) {
  if (!session || !session.tabs.length) return 0;
  const restored = [];
  let activeTab = null;
  for (const [i, entry] of session.tabs.entries()) {
    let tab;
    if (entry.path) {
      let file;
      try {
        file = await readFile(entry.path, null);
      } catch {
        continue;
      }
      tab = Tabs.newTab(entry.path, file.content, file.encoding, file.mtime ?? null);
    } else {
      tab = Tabs.newTab(null, entry.draft);
      Tabs.markDirtyTab(tab); // 下書きは未保存の内容なので ● を付ける
    }
    Tabs.setSelection(tab, entry.cursor);
    restored.push(tab);
    if (i === session.active) activeTab = tab;
  }
  if (restored.length) {
    Tabs.activate(Tabs.getTabs().indexOf(activeTab ?? restored[restored.length - 1]));
    Tabs.revealCursor();
  }
  return restored.length;
}
