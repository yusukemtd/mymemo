import {
  createEditorState,
  detectLanguage,
  languageEffect,
  setAllLineEndings,
  eolField,
} from "./editor.js";
import { invoke } from "@tauri-apps/api/core";
import { EditorView } from "@codemirror/view";

// タブ管理: 各タブが自分の EditorState を保持し、切替時にビューへ差し替える。
// undo 履歴も EditorState に含まれるためタブごとに維持される。

let tabs = [];
let activeIndex = -1;
let view = null;
let untitledCount = 0;
let onLastTabClosed = null; // 最後のタブを閉じたときの処理(既定はアプリ終了)

const tabbarEl = document.getElementById("tabbar");

// initialTab: 起動時に無題タブを 1 つ作る(セッション復元する場合は false にして後から作る)
export function initTabs(editorView, { initialTab = true, onLastTabClosed: onLast = null } = {}) {
  view = editorView;
  onLastTabClosed = onLast;
  const newBtn = document.createElement("button");
  newBtn.id = "tab-new";
  newBtn.textContent = "+";
  newBtn.title = "新規タブ (Cmd+N)";
  newBtn.addEventListener("click", () => newTab());
  tabbarEl.appendChild(newBtn);
  if (initialTab) newTab();
}

export function getActiveTab() {
  return tabs[activeIndex] ?? null;
}

export function getTabs() {
  return tabs;
}

// タブの現在の state(アクティブタブは view 側が最新)
export function stateOf(tab) {
  return tabs[activeIndex] === tab ? view.state : tab.state;
}

function markDirty() {
  markDirtyTab(tabs[activeIndex]);
}

// 指定タブを未保存扱いにする(セッション復元した下書きなど、編集を経ずに未保存にしたい場合)
export function markDirtyTab(tab) {
  if (tab && tabs.includes(tab) && !tab.dirty) {
    tab.dirty = true;
    render();
  }
}

// 指定タブのカーソル(選択範囲)を設定する。本文の長さを超える位置は末尾に丸める
export function setSelection(tab, { anchor, head }) {
  if (!tabs.includes(tab)) return;
  const len = stateOf(tab).doc.length;
  const clamp = (n) => Math.min(Math.max(n, 0), len);
  const selection = { anchor: clamp(anchor), head: clamp(head) };
  if (tabs[activeIndex] === tab) view.dispatch({ selection });
  else tab.state = tab.state.update({ selection }).state;
}

// アクティブタブのカーソル位置が見えるようスクロールする(setState 直後は先頭表示になるため)
export function revealCursor() {
  if (activeIndex < 0) return;
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }),
  });
}

// content は改行コード混在可の生テキスト(改行コードは state 側で行ごとに保持される)。
// mtime は読んだ時点のファイル更新時刻(UNIX ミリ秒。ディスク上の変更検知に使う。不明なら null)
export function newTab(path = null, content = "", encoding = "UTF-8", mtime = null) {
  untitledCount += path ? 0 : 1;
  const tab = {
    path,
    name: path ? path.split("/").pop() : `無題-${untitledCount}`,
    state: createEditorState(content, markDirty),
    dirty: false,
    encoding,
    mtime,
  };
  saveCurrentState();
  tabs.push(tab);
  activate(tabs.length - 1);
  applyLanguage(tab);
  return tab;
}

export function findTabByPath(path) {
  return tabs.findIndex((t) => t.path === path);
}

function saveCurrentState() {
  if (activeIndex >= 0 && tabs[activeIndex]) {
    tabs[activeIndex].state = view.state;
  }
}

// タブの path/内容から言語を検出し、非同期ロード後に state へ適用する。
// ロード中にタブが閉じられた/再検出が走った場合は結果を破棄する
let langLoadSeq = 0;
async function applyLanguage(tab) {
  const token = ++langLoadSeq;
  tab.langToken = token;
  const state = tabs[activeIndex] === tab ? view.state : tab.state;
  const firstLine = state.doc.line(1).text.slice(0, 100);
  const desc = detectLanguage(tab.path, firstLine);
  let support = null;
  if (desc) {
    try {
      support = await desc.load();
    } catch {
      return; // ロード失敗時はプレーンテキストのまま
    }
  }
  if (tab.langToken !== token) return;
  if (!tabs.includes(tab)) return;
  applyEffects(tab, languageEffect(support));
}

// 指定タブの state にエフェクトを適用する(アクティブなら view 経由、それ以外は保持中の state を差し替え)
function applyEffects(tab, effects) {
  if (tabs[activeIndex] === tab) view.dispatch({ effects });
  else tab.state = tab.state.update({ effects }).state;
}

// 全行の改行コードを統一する(別名保存・「編集 > 改行コードを変換」)。行末記号の表示も追従する。
// 既に揃っていれば何も起きない
export function convertLineEndings(tab, lineEnding) {
  if (!tabs.includes(tab)) return;
  const before = stateOf(tab).field(eolField);
  applyEffects(tab, setAllLineEndings.of(lineEnding));
  // アクティブタブは view の updateListener が未保存にするが、非アクティブタブでは動かないのでここで付ける
  if (stateOf(tab).field(eolField) !== before && !tab.dirty) {
    tab.dirty = true;
    render();
  }
}

// テーマ等の reconfigure を全タブに適用する。
// 非アクティブタブの state も update() で差し替える(undo 履歴は維持される)
export function applyToAllTabs(makeEffects) {
  tabs.forEach((t, i) => {
    if (i === activeIndex) {
      view.dispatch({ effects: makeEffects() });
    } else {
      t.state = t.state.update({ effects: makeEffects() }).state;
    }
  });
}

export function activate(index) {
  if (index < 0 || index >= tabs.length) return;
  saveCurrentState();
  activeIndex = index;
  view.setState(tabs[index].state);
  render();
  view.focus();
}

export function cycleTab(dir = 1) {
  if (tabs.length < 2) return;
  activate((activeIndex + dir + tabs.length) % tabs.length);
}

// onConfirmClose: (tab) => Promise<boolean> — 未保存タブを閉じてよいか
// quitIfLast: 最後のタブを閉じたらアプリを終了する(開き直し等の内部処理では false)
export async function closeTab(index, onConfirmClose, quitIfLast = true) {
  const t = tabs[index];
  if (!t) return;
  if (t.dirty && onConfirmClose && !(await onConfirmClose(t))) return;
  // アクティブタブの state はタブ切替時にしか同期されないため、閉じる前に保存する
  // (非アクティブタブを閉じたときにアクティブタブの編集が巻き戻るのを防ぐ)
  saveCurrentState();
  const wasActive = index === activeIndex;
  tabs.splice(index, 1);
  if (tabs.length === 0) {
    activeIndex = -1;
    if (quitIfLast) {
      if (onLastTabClosed) await onLastTabClosed();
      else await invoke("quit_app");
      return;
    }
    newTab();
    return;
  }
  if (activeIndex >= index) activeIndex = Math.max(0, activeIndex - 1);
  // 非アクティブタブを閉じた場合は表示中の view に触らない(スクロール位置等を保つ)
  if (wasActive) view.setState(tabs[activeIndex].state);
  render();
}

// 空の無題タブをファイル内容で置き換える
export function replaceActiveTab(path, content, encoding = "UTF-8", mtime = null) {
  const t = tabs[activeIndex];
  if (!t) return null;
  t.path = path;
  t.name = path.split("/").pop();
  t.dirty = false;
  t.encoding = encoding;
  t.mtime = mtime;
  t.state = createEditorState(content, markDirty);
  view.setState(t.state);
  applyLanguage(t);
  render();
  return t;
}

// ディスクから読み直した内容でタブの本文を差し替える(外部変更の反映・保存済みの状態に戻す)。
// カーソル位置は本文長の範囲で保つ。undo 履歴は引き継がない
export function replaceContent(tab, content, encoding, mtime = null) {
  if (!tabs.includes(tab)) return;
  const { anchor, head } = stateOf(tab).selection.main;
  tab.state = createEditorState(content, markDirty);
  tab.encoding = encoding;
  tab.mtime = mtime;
  tab.dirty = false;
  const active = tabs[activeIndex] === tab;
  if (active) view.setState(tab.state);
  setSelection(tab, { anchor, head });
  if (active) revealCursor();
  applyLanguage(tab);
  render();
}

// 保存完了時に呼ぶ。保存待ちの間にアクティブタブが切り替わっても
// 正しいタブへ反映されるよう、対象タブを引数で受け取る。mtime は書いた後の更新時刻
export function markSaved(tab, path, mtime = null) {
  if (!tabs.includes(tab)) return; // 保存中に閉じられたタブは無視
  tab.dirty = false;
  tab.mtime = mtime;
  if (path) {
    tab.path = path;
    tab.name = path.split("/").pop();
    applyLanguage(tab); // 別名保存で拡張子が変わった場合の言語再検出
  }
  render();
}

export function render() {
  tabbarEl.querySelectorAll(".tab").forEach((el) => el.remove());
  const newBtn = document.getElementById("tab-new");
  tabs.forEach((t, i) => {
    const el = document.createElement("div");
    el.className =
      "tab" + (i === activeIndex ? " active" : "") + (t.dirty ? " dirty" : "");
    el.title = t.path ?? t.name;

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = t.name;
    el.appendChild(name);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "✕";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      el.dispatchEvent(new CustomEvent("tab-close-request", { bubbles: true, detail: i }));
    });
    el.appendChild(close);

    el.addEventListener("click", () => activate(i));
    tabbarEl.insertBefore(el, newBtn);
  });
  window.dispatchEvent(new CustomEvent("active-tab-changed"));
}
