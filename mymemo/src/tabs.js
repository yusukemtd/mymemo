import { createEditorState, detectLanguage, languageEffect } from "./editor.js";
import { invoke } from "@tauri-apps/api/core";

// タブ管理: 各タブが自分の EditorState を保持し、切替時にビューへ差し替える。
// undo 履歴も EditorState に含まれるためタブごとに維持される。

let tabs = [];
let activeIndex = -1;
let view = null;
let untitledCount = 0;

const tabbarEl = document.getElementById("tabbar");

export function initTabs(editorView) {
  view = editorView;
  const newBtn = document.createElement("button");
  newBtn.id = "tab-new";
  newBtn.textContent = "+";
  newBtn.title = "新規タブ (Cmd+N)";
  newBtn.addEventListener("click", () => newTab());
  tabbarEl.appendChild(newBtn);
  newTab();
}

export function getActiveTab() {
  return tabs[activeIndex] ?? null;
}

export function getTabs() {
  return tabs;
}

function markDirty() {
  const t = tabs[activeIndex];
  if (t && !t.dirty) {
    t.dirty = true;
    render();
  }
}

export function newTab(path = null, content = "", encoding = "UTF-8", lineEnding = "LF") {
  untitledCount += path ? 0 : 1;
  const tab = {
    path,
    name: path ? path.split("/").pop() : `無題-${untitledCount}`,
    state: createEditorState(content, markDirty),
    dirty: false,
    encoding,
    lineEnding,
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
  const effects = languageEffect(support);
  if (tabs[activeIndex] === tab) view.dispatch({ effects });
  else tab.state = tab.state.update({ effects }).state;
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
      await invoke("quit_app");
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
export function replaceActiveTab(path, content, encoding = "UTF-8", lineEnding = "LF") {
  const t = tabs[activeIndex];
  if (!t) return;
  t.path = path;
  t.name = path.split("/").pop();
  t.dirty = false;
  t.encoding = encoding;
  t.lineEnding = lineEnding;
  t.state = createEditorState(content, markDirty);
  view.setState(t.state);
  applyLanguage(t);
  render();
}

// 保存完了時に呼ぶ。保存待ちの間にアクティブタブが切り替わっても
// 正しいタブへ反映されるよう、対象タブを引数で受け取る
export function markSaved(tab, path) {
  if (!tabs.includes(tab)) return; // 保存中に閉じられたタブは無視
  tab.dirty = false;
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
