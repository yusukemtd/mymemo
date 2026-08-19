import { createEditorState } from "./editor.js";

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
export async function closeTab(index, onConfirmClose) {
  const t = tabs[index];
  if (!t) return;
  if (t.dirty && onConfirmClose && !(await onConfirmClose(t))) return;
  tabs.splice(index, 1);
  if (tabs.length === 0) {
    activeIndex = -1;
    newTab();
    return;
  }
  if (activeIndex >= index) activeIndex = Math.max(0, activeIndex - 1);
  view.setState(tabs[activeIndex].state);
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
  render();
}

export function markSaved(path) {
  const t = tabs[activeIndex];
  if (!t) return;
  t.dirty = false;
  if (path) {
    t.path = path;
    t.name = path.split("/").pop();
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
