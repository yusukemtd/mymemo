import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

const panel = document.getElementById("grep-panel");
const dirBtn = document.getElementById("grep-dir-btn");
const dirLabel = document.getElementById("grep-dir-label");
const input = document.getElementById("grep-input");
const regexCb = document.getElementById("grep-regex");
const caseCb = document.getElementById("grep-case");
const runBtn = document.getElementById("grep-run");
const statusEl = document.getElementById("grep-status");
const resultsEl = document.getElementById("grep-results");
const closeBtn = document.getElementById("grep-close");

let searchDir = null;
let onJump = null; // (path, lineNumber) => void

export function initGrep(jumpHandler) {
  onJump = jumpHandler;

  dirBtn.addEventListener("click", async () => {
    const dir = await open({ directory: true });
    if (dir) {
      searchDir = dir;
      dirLabel.textContent = dir;
      dirLabel.title = dir;
    }
  });

  runBtn.addEventListener("click", runSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
    if (e.key === "Escape") hideGrep();
  });
  closeBtn.addEventListener("click", hideGrep);
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

async function runSearch() {
  const pattern = input.value;
  if (!pattern) return;
  if (!searchDir) {
    statusEl.textContent = "フォルダを選択してください";
    return;
  }
  statusEl.textContent = "検索中…";
  resultsEl.textContent = "";
  try {
    const res = await invoke("grep_search", {
      dir: searchDir,
      pattern,
      isRegex: regexCb.checked,
      caseSensitive: caseCb.checked,
    });
    renderResults(res);
  } catch (err) {
    statusEl.textContent = `エラー: ${err}`;
  }
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
