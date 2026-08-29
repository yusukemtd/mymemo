import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import {
  createEditorState,
  createView,
  setJumpHighlight,
  docWithLineEndings,
  describeLineEndings,
  describeCharCount,
  lineEndingSummary,
} from "./editor.js";
import * as Tabs from "./tabs.js";
import { initTheme, applyTheme } from "./theme.js";
import { initShowWhitespace, toggleShowWhitespace } from "./whitespace.js";
import { initLineWrap, toggleLineWrap } from "./wrap.js";
import { initFontSize, zoomIn, zoomOut, resetFontSize } from "./fontsize.js";
import { initGrep, toggleGrep } from "./grep.js";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";

// --- 起動 ---
initTheme(); // エディタ生成前に呼ぶ(初期 state のテーマ極性が決まる)
initShowWhitespace(); // 同上(初期 state の空白文字表示の有無が決まる)
initLineWrap(); // 同上(初期 state の折り返しの有無が決まる)
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
    await Tabs.closeTab(existing, null, false);
  }
  const active = Tabs.getActiveTab();
  // 空の無題タブなら再利用する
  if (active && !active.path && !active.dirty && view.state.doc.length === 0) {
    Tabs.replaceActiveTab(path, file.content, file.encoding);
  } else {
    Tabs.newTab(path, file.content, file.encoding);
  }
}

async function saveFile(as = false) {
  const tab = Tabs.getActiveTab();
  if (!tab) return false;
  // 保存対象はこの時点のタブ。IPC 待ちの間にタブが切り替わっても
  // 別のタブへ path や保存済みマークが付かないよう tab を引き回す
  let path = tab.path;
  let encoding = tab.encoding ?? "UTF-8";
  let convertTo = null; // 別名保存で改行コードの統一を選んだ場合(既定は行ごとに保持)
  if (as || !path) {
    // ネイティブ保存パネル内で文字コード・改行コードも選択できる
    const summary = lineEndingSummary(view.state);
    const choice = await invoke("save_dialog_with_options", {
      defaultName: tab.path ? tab.name : tab.name + ".txt",
      encoding,
      lineEnding: summary.mixed ? "混在" : summary.dominant,
    });
    if (!choice) return false;
    path = choice.path;
    encoding = choice.encoding;
    if (choice.line_ending !== "KEEP") convertTo = choice.line_ending;
  }
  // 改行コードは行ごとに保持しているのでフロント側で復元し、Rust 側はそのまま書く
  const content = docWithLineEndings(Tabs.stateOf(tab), convertTo);
  try {
    await invoke("write_file", { path, content, encoding });
    tab.encoding = encoding;
  } catch (err) {
    await message(String(err), { title: "mymemo", kind: "error" });
    return false;
  }
  // 統一を選んだ場合は保存に成功してからエディタ側の改行コードを揃える
  if (convertTo) Tabs.convertLineEndings(tab, convertTo);
  Tabs.markSaved(tab, path);
  return true;
}

// --- ステータスバー ---
const statusPos = document.getElementById("status-pos");
const statusCount = document.getElementById("status-count");
const statusEnc = document.getElementById("status-encoding");
const statusEol = document.getElementById("status-eol");

function updateStatusBar() {
  const tab = Tabs.getActiveTab();
  statusEnc.textContent = tab?.encoding ?? "UTF-8";
  statusEol.textContent = describeLineEndings(view.state);
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  statusPos.textContent = `${line.number} 行, ${head - line.from + 1} 列`;
  statusCount.textContent = describeCharCount(view.state);
}

window.addEventListener("active-tab-changed", updateStatusBar);
window.addEventListener("cursor-moved", updateStatusBar);
updateStatusBar();

// grep 結果からのジャンプ。ハイライト解除はジャンプ先のタブを覚えて行う
// (タイマー発火前にタブを切り替えても、残留したり別タブに誤爆したりしないように)
let jumpClear = null; // { tab, timer }

function clearJumpHighlight() {
  if (!jumpClear) return;
  clearTimeout(jumpClear.timer);
  const { tab } = jumpClear;
  jumpClear = null;
  if (Tabs.getActiveTab() === tab) {
    view.dispatch({ effects: setJumpHighlight.of(null) });
  } else if (Tabs.getTabs().includes(tab)) {
    tab.state = tab.state.update({ effects: setJumpHighlight.of(null) }).state;
  }
}

async function jumpTo(path, lineNumber) {
  clearJumpHighlight(); // 前回ジャンプ先の残留ハイライトを除去
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
  jumpClear = {
    tab: Tabs.getActiveTab(),
    timer: setTimeout(clearJumpHighlight, 1500),
  };
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
  if (payload.startsWith("theme:")) {
    applyTheme(payload.slice("theme:".length));
    return;
  }
  if (payload.startsWith("convert_eol:")) {
    // 全行の改行コードを統一する(保存はしない。undo で戻せる)
    Tabs.convertLineEndings(Tabs.getActiveTab(), payload.slice("convert_eol:".length));
    view.focus();
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
    case "toggle_whitespace":
      toggleShowWhitespace();
      break;
    case "toggle_wrap":
      toggleLineWrap();
      break;
    case "zoom_in":
      zoomIn();
      break;
    case "zoom_out":
      zoomOut();
      break;
    case "zoom_reset":
      resetFontSize();
      break;
    case "quit":
      // 未保存確認を挟むため、終了メニューは PredefinedMenuItem::quit ではなく
      // カスタム ID で受けてここで処理する
      if (await confirmQuit()) await invoke("quit_app");
      break;
  }
});

// --- ファイルのドラッグ&ドロップで開く ---
getCurrentWebview().onDragDropEvent(async ({ payload }) => {
  if (payload.type === "enter") {
    document.body.classList.add("drag-over");
  } else if (payload.type === "leave") {
    document.body.classList.remove("drag-over");
  } else if (payload.type === "drop") {
    document.body.classList.remove("drag-over");
    for (const path of payload.paths) {
      await openFile(path);
    }
  }
});

// --- Finder の「このアプリケーションで開く」・ダブルクリック・Dock へのドロップで開く ---
// Rust 側(open_files.rs)が RunEvent::Opened を "open-files" に変換して送ってくる。
// 起動と同時に渡されたファイルはリスナー登録前に届くため Rust 側に溜まっており、
// リスナー登録が完了してから take_pending_open_files で引き取る(順序を保証するため直列にする)
listen("open-files", async ({ payload }) => {
  for (const path of payload) await openFile(path);
})
  .then(() => invoke("take_pending_open_files"))
  .then(async (paths) => {
    for (const path of paths) await openFile(path);
  });

// --- フォントサイズ(「表示 > 拡大 / 縮小 / 標準サイズ」と Cmd+スクロール。保存値を復元) ---
initFontSize(() => view.requestMeasure());

container.addEventListener(
  "wheel",
  (e) => {
    if (!e.metaKey) return;
    e.preventDefault();
    (e.deltaY < 0 ? zoomIn : zoomOut)();
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

// 終了前の未保存確認(ウィンドウを閉じる操作と Cmd+Q の両方で使う)
async function confirmQuit() {
  const dirtyCount = Tabs.getTabs().filter((t) => t.dirty).length;
  if (dirtyCount === 0) return true;
  return confirm(
    `未保存のタブが ${dirtyCount} 個あります。変更を破棄して終了しますか?`,
    { title: "mymemo", kind: "warning" }
  );
}

getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await confirmQuit())) event.preventDefault();
});
