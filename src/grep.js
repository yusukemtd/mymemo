import { invoke } from "@tauri-apps/api/core";
import { open, confirm, message } from "@tauri-apps/plugin-dialog";

const panel = document.getElementById("grep-panel");
const dirBtn = document.getElementById("grep-dir-btn");
const dirLabel = document.getElementById("grep-dir-label");
const input = document.getElementById("grep-input");
const globInput = document.getElementById("grep-glob");
const replaceInput = document.getElementById("grep-replace");
const replaceBtn = document.getElementById("grep-replace-all");
const regexCb = document.getElementById("grep-regex");
const caseCb = document.getElementById("grep-case");
const runBtn = document.getElementById("grep-run");
const statusEl = document.getElementById("grep-status");
const resultsEl = document.getElementById("grep-results");
const closeBtn = document.getElementById("grep-close");

let searchDir = null;
let onJump = null; // (path, lineNumber) => void
let onReplaced = null; // 置換でファイルを書き換えた後に呼ぶ(開いているタブへの反映)

// "*.md !node_modules, src/**/*.js" → ["*.md", "!node_modules", "src/**/*.js"]
export function parseGlobs(value) {
  return value.split(/[\s,]+/).filter(Boolean);
}

export function initGrep(jumpHandler, { afterReplace = null } = {}) {
  onJump = jumpHandler;
  onReplaced = afterReplace;

  dirBtn.addEventListener("click", async () => {
    const dir = await open({ directory: true });
    if (dir) {
      searchDir = dir;
      dirLabel.textContent = dir;
      dirLabel.title = dir;
    }
  });

  runBtn.addEventListener("click", runSearch);
  replaceBtn.addEventListener("click", runReplace);
  for (const el of [input, globInput, replaceInput]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") (el === replaceInput ? runReplace : runSearch)();
      if (e.key === "Escape") hideGrep();
    });
  }
  closeBtn.addEventListener("click", hideGrep);
}

// 検索・置換に共通の条件(空なら null で理由をステータスに出す)
function currentQuery() {
  const pattern = input.value;
  if (!pattern) return null;
  if (!searchDir) {
    statusEl.textContent = "フォルダを選択してください";
    return null;
  }
  return {
    dir: searchDir,
    pattern,
    isRegex: regexCb.checked,
    caseSensitive: caseCb.checked,
    globs: parseGlobs(globInput.value),
  };
}

export function toggleGrep() {
  if (panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
    input.focus();
    input.select();
  } else {
    hideGrep();
  }
}

export function hideGrep() {
  panel.classList.add("hidden");
}

// 検索して結果を表示する。結果(失敗なら null)を返す
async function runSearch() {
  const query = currentQuery();
  if (!query) return null;
  statusEl.textContent = "検索中…";
  resultsEl.textContent = "";
  try {
    const res = await invoke("grep_search", query);
    renderResults(res);
    return res;
  } catch (err) {
    statusEl.textContent = `エラー: ${err}`;
    return null;
  }
}

// 一致をすべて置換してファイルへ書き戻す。対象を見せるため先に検索し、件数を出して確認する
async function runReplace() {
  const query = currentQuery();
  if (!query) return;
  const res = await runSearch();
  if (!res) return;
  if (!res.hits.length) {
    statusEl.textContent = "一致なし";
    return;
  }
  const files = new Set(res.hits.map((h) => h.path)).size;
  const lines = res.hits.length.toLocaleString("ja-JP") + (res.truncated ? "+" : "");
  const ok = await confirm(
    `${files}${res.truncated ? "+" : ""} ファイル・${lines} 行の一致を「${replaceInput.value}」に置換してファイルへ書き戻します。元に戻せません。よろしいですか?`,
    { title: "mymemo", kind: "warning" }
  );
  if (!ok) return;
  statusEl.textContent = "置換中…";
  try {
    const r = await invoke("grep_replace", { ...query, replacement: replaceInput.value });
    resultsEl.textContent = "";
    statusEl.textContent = `${r.files} ファイル・${r.replacements} 件を置換しました`;
  } catch (err) {
    statusEl.textContent = `エラー: ${err}`;
    await message(String(err), { title: "mymemo", kind: "error" });
  }
  await onReplaced?.(); // 途中で失敗しても書き換わったファイルはあるので、開いているタブへ反映する
}

function renderResults({ hits, truncated }) {
  statusEl.textContent =
    `${hits.length} 件` + (truncated ? "(上限で打ち切り)" : "");
  resultsEl.textContent = "";
  let currentFile = null;
  const frag = document.createDocumentFragment();
  for (const hit of hits) {
    if (hit.path !== currentFile) {
      currentFile = hit.path;
      const fileEl = document.createElement("div");
      fileEl.className = "grep-file";
      fileEl.textContent = displayPath(hit.path);
      frag.appendChild(fileEl);
    }
    const el = document.createElement("div");
    el.className = "grep-hit";
    const ln = document.createElement("span");
    ln.className = "lineno";
    ln.textContent = hit.line_number;
    const text = document.createElement("span");
    text.textContent = hit.line_text.trimEnd();
    el.appendChild(ln);
    el.appendChild(text);
    el.addEventListener("click", () => onJump?.(hit.path, hit.line_number));
    frag.appendChild(el);
  }
  resultsEl.appendChild(frag);
}

function displayPath(p) {
  return searchDir && p.startsWith(searchDir)
    ? p.slice(searchDir.length + 1)
    : p;
}
