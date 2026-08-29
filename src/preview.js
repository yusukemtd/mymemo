import { marked } from "marked";
import { invoke } from "@tauri-apps/api/core";

// Markdown プレビュー(表示 > Markdown プレビュー): アクティブタブの本文を marked で HTML にし、
// 許可リスト方式でサニタイズしてからエディタの右に表示する。本文の変更は 150ms 遅らせて反映し、
// エディタのスクロールに比例して追従する(見出し単位の同期ではない)。
// 生 HTML は script などを含みうるため、許可したタグ・属性以外はすべて落とす(webview は Tauri の IPC に届くので必須)

marked.use({ gfm: true, breaks: false });

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
  "em", "strong", "del", "s", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "input", "sup", "sub",
]);
// 中身ごと消すタグ(それ以外の許可外タグは中身だけ残す)
const REMOVE_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "link", "meta", "base", "form", "textarea", "button",
  "select", "svg", "math", "template", "noscript", "head", "title",
]);
const SAFE_HREF = /^(https?:|mailto:|#)/i;
// 画像は http(s) と data:image だけ(ローカルファイルの相対パスは asset プロトコルが要るので対応しない)
const SAFE_SRC = /^(https?:|data:image\/)/i;

function sanitizeAttrs(el, tag) {
  const keep = {};
  const get = (name) => el.getAttribute(name)?.trim() ?? "";
  if (tag === "a") {
    const href = get("href");
    if (SAFE_HREF.test(href)) keep.href = href;
    if (el.hasAttribute("title")) keep.title = get("title");
  } else if (tag === "img") {
    const src = get("src");
    if (SAFE_SRC.test(src)) keep.src = src;
    if (!keep.src) return false; // 表示できない画像は外す
    if (el.hasAttribute("alt")) keep.alt = get("alt");
    if (el.hasAttribute("title")) keep.title = get("title");
  } else if (tag === "th" || tag === "td") {
    const align = get("align").toLowerCase();
    if (["left", "right", "center"].includes(align)) keep.align = align;
  } else if (tag === "code") {
    const cls = get("class");
    if (/^language-[\w+.-]+$/.test(cls)) keep.class = cls;
  } else if (tag === "input") {
    if (get("type").toLowerCase() !== "checkbox") return false;
    keep.type = "checkbox";
    keep.disabled = "";
    if (el.hasAttribute("checked")) keep.checked = "";
  } else if (tag === "ol") {
    const start = get("start");
    if (/^\d+$/.test(start)) keep.start = start;
  }
  for (const { name } of [...el.attributes]) el.removeAttribute(name);
  for (const [name, value] of Object.entries(keep)) el.setAttribute(name, value);
  return true;
}

function walk(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.COMMENT_NODE) {
      node.remove();
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = node.tagName.toLowerCase();
    if (REMOVE_TAGS.has(tag)) {
      node.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      walk(node);
      node.replaceWith(...node.childNodes);
      continue;
    }
    if (!sanitizeAttrs(node, tag)) {
      node.remove();
      continue;
    }
    walk(node);
  }
}

export function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  walk(doc.body);
  return doc.body.innerHTML;
}

export function renderMarkdown(text) {
  return sanitizeHtml(marked.parse(text));
}

// --- ペインの管理 ---
const UPDATE_DELAY = 150;
let view = null;
let pane = null;
let area = null;
let shown = false;
let timer = null;
let renderedDoc = null; // 最後に描画した Text(同じなら描画しない)

export function initPreview(editorView) {
  view = editorView;
  pane = document.getElementById("preview");
  area = document.getElementById("editor-area");
  // リンクはページ遷移させず、http(s) / mailto だけ既定のブラウザで開く(# は何もしない)
  pane.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) invoke("open_url", { url: href }).catch(console.error);
  });
  // エディタのスクロール位置に比例して追従する
  view.scrollDOM.addEventListener("scroll", () => {
    if (!shown) return;
    const s = view.scrollDOM;
    const max = s.scrollHeight - s.clientHeight;
    if (max <= 0) return;
    pane.scrollTop = (s.scrollTop / max) * (pane.scrollHeight - pane.clientHeight);
  });
}

export function isPreviewShown() {
  return shown;
}

export function setPreviewVisible(show) {
  shown = show;
  pane.hidden = !show;
  area.classList.toggle("split", show);
  if (show) render();
  else renderedDoc = null;
  view.requestMeasure();
}

function render() {
  if (!shown) return;
  const doc = view.state.doc;
  if (doc === renderedDoc) return;
  renderedDoc = doc;
  pane.innerHTML = renderMarkdown(doc.toString());
}

// 本文・タブが変わったときに呼ぶ(表示中だけ、150ms のデバウンスで描画)
export function schedulePreviewUpdate() {
  if (!shown) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    render();
  }, UPDATE_DELAY);
}
