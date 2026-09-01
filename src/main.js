import { EditorView } from "@codemirror/view";
import { openSearchPanel, gotoLine } from "@codemirror/search";
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
import {
  showWhitespace,
  lineWrap,
  foldGutter,
  closeBrackets,
  wordCompletion,
  markdownPreview,
  restoreSessionOnStartup,
  TOGGLES,
} from "./toggles.js";
import { saveSession, scheduleSaveSession, restoreSession } from "./session.js";
import { initPreview, schedulePreviewUpdate } from "./preview.js";
import { foldCode, unfoldCode, foldAll, unfoldAll } from "@codemirror/language";
import { initFontSize, zoomIn, zoomOut, resetFontSize } from "./fontsize.js";
import {
  initIndent,
  setDefaultIndent,
  normalizeIndent,
  describeIndent,
  syncIndentMenu,
} from "./indent.js";
import { initGrep, toggleGrep } from "./grep.js";
import { checkExternalChanges, needsOverwriteConfirm, reloadTab } from "./external.js";
import { applyLineTransform } from "./transform.js";
import { MARKDOWN_COMMANDS } from "./markdown.js";
import {
  initRecentFiles,
  addRecentFile,
  removeRecentFile,
  clearRecentFiles,
  getRecentFiles,
} from "./recent.js";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";

// --- 起動 ---
initTheme(); // エディタ生成前に呼ぶ(初期 state のテーマ極性が決まる)
showWhitespace.init(); // 同上(初期 state の空白文字表示の有無が決まる)
lineWrap.init(); // 同上(初期 state の折り返しの有無が決まる)
foldGutter.init(); // 同上(初期 state の折りたたみガターの有無が決まる)
closeBrackets.init(); // 同上(初期 state の括弧自動補完の有無が決まる)
wordCompletion.init(); // 同上(初期 state の単語補完の有無が決まる)
initIndent(); // 同上(判定できないファイルのインデント既定値が決まる)
const container = document.getElementById("editor-container");
const view = createView(container, createEditorState("", () => {}));
// 起動時の無題タブはセッション復元と起動時に渡されたファイルの有無を見てから作る(後述の open-files 処理)
Tabs.initTabs(view, { initialTab: false, onLastTabClosed: quitApp });

// --- Markdown プレビュー(表示 > Markdown プレビュー)。本文・タブの変化に追従する ---
initPreview(view);
markdownPreview.init();
window.addEventListener("active-tab-changed", schedulePreviewUpdate);
window.addEventListener("cursor-moved", schedulePreviewUpdate);

// --- セッション復元(前回開いていたタブと無題タブの下書き)---
// 「mymemo > 起動時に前回のタブを復元」が OFF なら復元せず、空の無題タブ
// (起動時にファイルを渡されたらそのファイルだけ)で起動する
restoreSessionOnStartup.init();
const restoring = restoreSessionOnStartup.get()
  ? restoreSession((path, encoding) => invoke("read_file", { path, encoding }))
  : Promise.resolve(0);

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
    removeRecentFile(path); // 開けなくなったファイルは履歴から外す
    await message(String(err), { title: "mymemo", kind: "error" });
    return;
  }
  addRecentFile(path);
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
    Tabs.replaceActiveTab(path, file.content, file.encoding, file.mtime ?? null);
  } else {
    Tabs.newTab(path, file.content, file.encoding, file.mtime ?? null);
  }
}

// ディスク上の変更検知(external.js)に渡す IPC とダイアログ
const externalDeps = {
  fileMtime: (path) => invoke("file_mtime", { path }),
  readFile: (path, encoding) => invoke("read_file", { path, encoding }),
  confirm: (tab) =>
    confirm(
      `「${tab.name}」はディスク上で変更されています。未保存の編集内容を破棄して読み直しますか?`,
      { title: "mymemo", kind: "warning" }
    ),
};

// 「ファイル > 保存済みの状態に戻す」: 編集を捨ててディスクの内容を読み直す
async function revertFile() {
  const tab = Tabs.getActiveTab();
  if (!tab?.path) return;
  if (
    tab.dirty &&
    !(await confirm(`「${tab.name}」の編集内容を破棄して保存済みの状態に戻しますか?`, {
      title: "mymemo",
      kind: "warning",
    }))
  ) {
    return;
  }
  try {
    await reloadTab(tab, externalDeps.readFile);
  } catch (err) {
    await message(String(err), { title: "mymemo", kind: "error" });
  }
}

// 「ファイル > Finder で表示」・タブ右クリック: ファイルを Finder で選択した状態で表示する
async function revealInFinder(tab) {
  if (!tab?.path) return;
  try {
    await invoke("reveal_in_finder", { path: tab.path });
  } catch (err) {
    await message(String(err), { title: "mymemo", kind: "error" });
  }
}

// 「ファイル > パスをコピー」・タブ右クリック: ファイルのフルパスをクリップボードへ
async function copyPath(tab) {
  if (!tab?.path) return;
  try {
    await navigator.clipboard.writeText(tab.path);
  } catch (err) {
    await message(`パスをコピーできませんでした: ${err}`, { title: "mymemo", kind: "error" });
  }
}

// タブ右クリックの「他のタブを閉じる」。未保存の確認は 1 タブずつ(断ったタブは残る)
async function closeOtherTabs(keepIndex) {
  const keep = Tabs.getTabs()[keepIndex];
  if (!keep) return;
  // 後ろから閉じると、閉じるたびに index がずれるのを気にしなくてよい
  for (let i = Tabs.getTabs().length - 1; i >= 0; i--) {
    if (Tabs.getTabs()[i] !== keep) await Tabs.closeTab(i, confirmDiscard);
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
  } else {
    // 上書き保存: 開いた後にディスク上で変更されていれば確認する(別名保存は OS の置換確認に任せる)
    let disk = null;
    try {
      disk = await invoke("file_mtime", { path });
    } catch {}
    if (
      needsOverwriteConfirm(tab, disk) &&
      !(await confirm(`「${tab.name}」は開いた後にディスク上で変更されています。上書きしますか?`, {
        title: "mymemo",
        kind: "warning",
      }))
    ) {
      return false;
    }
  }
  // 改行コードは行ごとに保持しているのでフロント側で復元し、Rust 側はそのまま書く
  const content = docWithLineEndings(Tabs.stateOf(tab), convertTo);
  let mtime = null;
  try {
    mtime = await invoke("write_file", { path, content, encoding });
    tab.encoding = encoding;
  } catch (err) {
    await message(String(err), { title: "mymemo", kind: "error" });
    return false;
  }
  // 統一を選んだ場合は保存に成功してからエディタ側の改行コードを揃える
  if (convertTo) Tabs.convertLineEndings(tab, convertTo);
  Tabs.markSaved(tab, path, mtime ?? null);
  addRecentFile(path);
  return true;
}

// --- ステータスバー ---
const statusPos = document.getElementById("status-pos");
const statusCount = document.getElementById("status-count");
const statusIndent = document.getElementById("status-indent");
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
  statusIndent.textContent = tab ? describeIndent(tab.indent) : "";
  if (tab) syncIndentMenu(tab.indent);
}

// 「編集 > インデント」: アクティブタブの設定を変え、判定できないファイル用の既定値としても覚える
function changeIndent(patch) {
  const tab = Tabs.getActiveTab();
  if (!tab) return;
  const settings = normalizeIndent({ ...tab.indent, ...patch });
  Tabs.setIndent(tab, settings);
  setDefaultIndent(settings);
}

window.addEventListener("active-tab-changed", updateStatusBar);
window.addEventListener("cursor-moved", updateStatusBar);
updateStatusBar();

// ステータスバーの文字コード・改行コードをクリックすると変更メニュー(Rust 側のポップアップ)が出る
statusEnc.addEventListener("click", () => {
  const tab = Tabs.getActiveTab();
  if (tab) invoke("popup_status_menu", { kind: "encoding", current: tab.encoding }).catch(console.error);
});
statusEol.addEventListener("click", () => {
  const summary = lineEndingSummary(view.state);
  invoke("popup_status_menu", { kind: "eol", current: summary.mixed ? "" : summary.dominant }).catch(
    console.error
  );
});

// タブ・本文・カーソルが変わったらセッションを保存する(1 秒のデバウンス。終了直前にも保存する)。
// 復元が OFF でも保存は続ける(ON に戻した次の起動で最新のセッションを復元できるように)
window.addEventListener("active-tab-changed", scheduleSaveSession);
window.addEventListener("cursor-moved", scheduleSaveSession);

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

// grep の置換で書き換わったファイルは、ディスク上の変更検知と同じ経路で開いているタブへ反映する
initGrep(jumpTo, { afterReplace: () => checkExternalChanges(externalDeps) });

// タブの閉じるボタン(中クリックも同じイベントで届く)
document.getElementById("tabbar").addEventListener("tab-close-request", (e) => {
  Tabs.closeTab(e.detail, confirmDiscard);
});

// タブの右クリックメニュー。メニュー項目は Rust 側で作り、選択はメニューバーと同じ
// menu イベントで届くため、対象タブの index をここで覚えておく
let tabCtxIndex = -1;
document.getElementById("tabbar").addEventListener("tab-context-menu", (e) => {
  tabCtxIndex = e.detail;
  const t = Tabs.getTabs()[tabCtxIndex];
  invoke("popup_tab_menu", { hasPath: !!t?.path }).catch(console.error);
});

// --- 最近使ったファイル(メニュー項目は Rust 側が履歴から作り直す) ---
initRecentFiles();

// --- メニュー(日本語ネイティブメニューは Rust 側で定義)からのイベント ---
listen("menu", async ({ payload }) => {
  if (payload.startsWith("open_enc:")) {
    await openFile(null, payload.slice("open_enc:".length));
    return;
  }
  if (payload in TOGGLES) {
    // 表示・編集の ON/OFF 設定(空白文字表示・折り返しなど)
    TOGGLES[payload].toggle();
    return;
  }
  if (payload.startsWith("md:")) {
    // Markdown の書式・行操作(md:<kind> または md:<kind>:<引数>)
    const [kind, arg] = payload.slice("md:".length).split(":");
    MARKDOWN_COMMANDS[kind]?.(view, arg);
    view.focus();
    return;
  }
  if (payload.startsWith("transform:")) {
    applyLineTransform(view, payload.slice("transform:".length));
    view.focus();
    return;
  }
  if (payload.startsWith("set_enc:")) {
    // 保存時の文字コードを変える(読み直しはしない。読み直すなら「文字コードを指定して開く」)
    Tabs.setEncoding(Tabs.getActiveTab(), payload.slice("set_enc:".length));
    view.focus();
    return;
  }
  if (payload.startsWith("tabsize:")) {
    changeIndent({ tabSize: Number(payload.slice("tabsize:".length)) });
    view.focus();
    return;
  }
  if (payload.startsWith("recent:")) {
    const path = getRecentFiles()[Number(payload.slice("recent:".length))];
    if (path) await openFile(path);
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
    case "revert":
      await revertFile();
      view.focus();
      break;
    case "recent_clear":
      clearRecentFiles();
      break;
    case "soft_tabs":
      changeIndent({ softTabs: !Tabs.getActiveTab()?.indent.softTabs });
      view.focus();
      break;
    case "close_tab":
      await Tabs.closeTab(
        Tabs.getTabs().indexOf(Tabs.getActiveTab()),
        confirmDiscard
      );
      break;
    case "reopen_tab": {
      // 閉じたタブを新しい順に開き直す(無題タブは対象外。既に開いていれば切り替わる)
      const path = Tabs.popClosedTabPath();
      if (path) await openFile(path);
      break;
    }
    case "reveal_in_finder":
      await revealInFinder(Tabs.getActiveTab());
      break;
    case "copy_path":
      await copyPath(Tabs.getActiveTab());
      break;
    case "tabctx_close":
      await Tabs.closeTab(tabCtxIndex, confirmDiscard);
      break;
    case "tabctx_close_others":
      await closeOtherTabs(tabCtxIndex);
      break;
    case "tabctx_reveal":
      await revealInFinder(Tabs.getTabs()[tabCtxIndex]);
      break;
    case "tabctx_copy_path":
      await copyPath(Tabs.getTabs()[tabCtxIndex]);
      break;
    case "find":
      openSearchPanel(view);
      view.focus();
      break;
    case "grep":
      toggleGrep();
      break;
    case "goto_line":
      gotoLine(view); // CodeMirror 標準の行番号入力パネル(文言は japanesePhrases で日本語化済み)
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
    case "fold_code":
    case "unfold_code":
    case "fold_all":
    case "unfold_all":
      ({ fold_code: foldCode, unfold_code: unfoldCode, fold_all: foldAll, unfold_all: unfoldAll })[payload](view);
      view.focus();
      break;
    case "quit":
      // 未保存確認を挟むため、終了メニューは PredefinedMenuItem::quit ではなく
      // カスタム ID で受けてここで処理する
      if (await confirmQuit()) await quitApp();
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
// リスナー登録が完了してから take_pending_open_files で引き取る(順序を保証するため直列にする)。
// セッション復元より後に開いて、復元したタブの後ろに並ぶようにする
restoring
  .then(() =>
    listen("open-files", async ({ payload }) => {
      for (const path of payload) await openFile(path);
    })
  )
  .then(() => invoke("take_pending_open_files"))
  .then(async (paths) => {
    for (const path of paths) await openFile(path);
    // 復元したタブも起動時に渡されたファイルも無ければ、空の無題タブを 1 つ作る
    if (Tabs.getTabs().length === 0) Tabs.newTab();
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
  // Cmd+1〜9 で左から n 番目のタブへ切り替える
  if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    Tabs.activate(Number(e.key) - 1);
  }
});

// 終了(最後のタブを閉じた・確認済みの Cmd+Q)。直前にセッションを保存する
async function quitApp() {
  saveSession();
  await invoke("quit_app");
}

// 終了前の未保存確認(ウィンドウを閉じる操作と Cmd+Q の両方で使う)。
// 無題タブの下書きはセッションとして保存され次回復元されるので確認対象から外す
// (保存に失敗した・復元を OFF にしているときは復元されないので対象に戻す)
async function confirmQuit() {
  const restorable = saveSession() && restoreSessionOnStartup.get();
  const dirtyCount = Tabs.getTabs().filter((t) => t.dirty && (t.path || !restorable)).length;
  if (dirtyCount === 0) return true;
  return confirm(
    `未保存のタブが ${dirtyCount} 個あります。変更を破棄して終了しますか?`,
    { title: "mymemo", kind: "warning" }
  );
}

getCurrentWindow().onCloseRequested(async (event) => {
  if (!(await confirmQuit())) event.preventDefault();
});

// --- ウィンドウが前面に戻ったら、開いているファイルがディスク上で変更されていないか確認する ---
getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) checkExternalChanges(externalDeps);
});
