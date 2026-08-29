// エディタのフォントサイズ: CSS 変数 --editor-font-size の更新 + localStorage 永続化。
// メニュー(拡大 / 縮小 / 標準サイズ)と Cmd+スクロールの両方から使う

const STORAGE_KEY = "mymemo.fontSize";
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 48;

let fontSize = DEFAULT_FONT_SIZE;
let onApply = null; // サイズ反映後に呼ぶ(EditorView.requestMeasure など)

export function clampFontSize(size) {
  if (size == null || size === "") return DEFAULT_FONT_SIZE;
  const n = Math.round(Number(size));
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n));
}

export function getFontSize() {
  return fontSize;
}

export function applyFontSize(size) {
  fontSize = clampFontSize(size);
  document.documentElement.style.setProperty("--editor-font-size", `${fontSize}px`);
  try {
    localStorage.setItem(STORAGE_KEY, String(fontSize));
  } catch {}
  onApply?.(fontSize);
}

export function zoomIn() {
  applyFontSize(fontSize + 1);
}

export function zoomOut() {
  applyFontSize(fontSize - 1);
}

export function resetFontSize() {
  applyFontSize(DEFAULT_FONT_SIZE);
}

// 保存済みサイズの復元(不正値・未保存なら既定値)
export function initFontSize(applyCallback) {
  onApply = applyCallback ?? null;
  let saved = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {}
  applyFontSize(saved == null ? DEFAULT_FONT_SIZE : saved);
}
