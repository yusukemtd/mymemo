import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import {
  createEditorState,
  createView,
  setJumpHighlight,
} from "./editor.js";
import * as Tabs from "./tabs.js";
import { initGrep, toggleGrep } from "./grep.js";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";

// --- 起動 ---
const container = document.getElementById("editor-container");
const view = createView(container, createEditorState("", () => {}));
Tabs.initTabs(view);

// --- ファイル操作 ---
async function confirmDiscard(tab) {
  return confirm(`「${tab.name}」は未保存です。変更を破棄して閉じますか?`, {
    title: "mymemo",
    kind: "warning",
  });
}

async function openFile(path = null, encoding = null) {
  if (!path) {
    path = await open({ multiple: false });
    if (!path) return;
  }
  const existing = Tabs.findTabByPath(path);
  if (existing >= 0 && !encoding) {
    Tabs.activate(existing);
    return;
  }
  let file;
  try {
    file = await invoke("read_file", { path, encoding });
  } catch (err) {
    await message(String(err), { title: "mymemo", kind: "error" });
    return;
  }
  if (file.lossy) {
    await message(
      `${file.encoding} として正しく読めない文字があり、置換されています。`,
      { title: "mymemo", kind: "warning" }
    );
  }
  // 文字コード指定で開き直す場合は既存タブを閉じてから開く
  if (existing >= 0) {
    const t = Tabs.getTabs()[existing];
    Tabs.activate(existing);
    if (t.dirty && !(await confirmDiscard(t))) return;
    t.dirty = false;
    await Tabs.closeTab(existing, null);
  }
  const active = Tabs.getActiveTab();
  // 空の無題タブなら再利用する
  if (active && !active.path && !active.dirty && view.state.doc.length === 0) {
    Tabs.replaceActiveTab(path, file.content, file.encoding, file.line_ending);
  } else {
    Tabs.newTab(path, file.content, file.encoding, file.line_ending);
  }
}

async function saveFile(as = false) {
  const tab = Tabs.getActiveTab();
  if (!tab) return false;
  let path = tab.path;
  let encoding = tab.encoding ?? "UTF-8";
  let lineEnding = tab.lineEnding ?? "LF";
  if (as || !path) {
    // ネイティブ保存パネル内で文字コード・改行コードも選択できる
    const choice = await invoke("save_dialog_with_options", {
      defaultName: tab.path ? tab.name : tab.name + ".txt",
      encoding,
      lineEnding,
    });
    if (!choice) return false;
    path = choice.path;
    encoding = choice.encoding;
    lineEnding = choice.line_ending;
  }
  try {
    await invoke("write_file", {
      path,
      content: view.state.doc.toString(),
      encoding,
      lineEnding,
    });
    tab.encoding = encoding;
    tab.lineEnding = lineEnding;
  } catch (err) {
    await message(String(err), { title: "mymemo", kind: "error" });
    return false;
  }
  Tabs.markSaved(path);
  return true;
}

// --- ステータスバー ---
const statusPos = document.getElementById("status-pos");
const statusEnc = document.getElementById("status-encoding");
const statusEol = document.getElementById("status-eol");

function updateStatusBar() {
  const tab = Tabs.getActiveTab();
  statusEnc.textContent = tab?.encoding ?? "UTF-8";
  statusEol.textContent = tab?.lineEnding ?? "LF";
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  statusPos.textContent = `${line.number} 行, ${head - line.from + 1} 列`;
}

window.addEventListener("active-tab-changed", updateStatusBar);
window.addEventListener("cursor-moved", updateStatusBar);
updateStatusBar();

// grep 結果からのジャンプ
async function jumpTo(path, lineNumber) {
  await openFile(path);
  const line = view.state.doc.line(
    Math.min(lineNumber, view.state.doc.lines)
  );
  view.dispatch({
    selection: { anchor: line.from },
    effects: [
      EditorView.scrollIntoView(line.from, { y: "center" }),
      setJumpHighlight.of(line.from),
    ],
  });
  view.focus();
  setTimeout(() => {
    view.dispatch({ effects: setJumpHighlight.of(null) });
  }, 1500);
}

initGrep(jumpTo);

// タブの閉じるボタン
document.getElementById("tabbar").addEventListener("tab-close-request", (e) => {
  Tabs.closeTab(e.detail, confirmDiscard);
});

// --- メニュー(日本語ネイティブメニューは Rust 側で定義)からのイベント ---
listen("menu", async ({ payload }) => {
  if (payload.startsWith("open_enc:")) {
    await openFile(null, payload.slice("open_enc:".length));
    return;
  }
  switch (payload) {
    case "new":
      Tabs.newTab();
      break;
    case "open":
      await openFile();
      break;
    case "save":
      await saveFile(false);
      break;
    case "save_as":
      await saveFile(true);
      break;
    case "close_tab":
      await Tabs.closeTab(
        Tabs.getTabs().indexOf(Tabs.getActiveTab()),
        confirmDiscard
      );
      break;
    case "find":
      openSearchPanel(view);
      view.focus();
      break;
    case "grep":
      toggleGrep();
      break;
  }
});

// --- Cmd+スクロールでフォントサイズ変更 ---
let fontSize = 13;

function setFontSize(size) {
  fontSize = Math.min(48, Math.max(8, size));
  document.documentElement.style.setProperty(
    "--editor-font-size",
    `${fontSize}px`
  );
  view.requestMeasure();
}

container.addEventListener(
  "wheel",
  (e) => {
    if (!e.metaKey) return;
    e.preventDefault();
    setFontSize(fontSize + (e.deltaY < 0 ? 1 : -1));
  },
  { passive: false }
);

// メニューにない補助キーバインド
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    Tabs.cycleTab(e.shiftKey ? -1 : 1);
  }
});

// ウィンドウを閉じる際の未保存確認
getCurrentWindow().onCloseRequested(async (event) => {
  const dirtyTabs = Tabs.getTabs().filter((t) => t.dirty);
  if (dirtyTabs.length > 0) {
    const ok = await confirm(
      `未保存のタブが ${dirtyTabs.length} 個あります。変更を破棄して終了しますか?`,
      { title: "mymemo", kind: "warning" }
    );
    if (!ok) event.preventDefault();
  }
});
