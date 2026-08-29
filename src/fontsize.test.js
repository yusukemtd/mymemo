import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  clampFontSize,
  initFontSize,
  applyFontSize,
  getFontSize,
  zoomIn,
  zoomOut,
  resetFontSize,
  DEFAULT_FONT_SIZE,
  MIN_FONT_SIZE,
  MAX_FONT_SIZE,
} from "./fontsize.js";

const cssSize = () => document.documentElement.style.getPropertyValue("--editor-font-size");

// vitest の jsdom 環境には localStorage が無いのでメモリ上のスタブを使う
const store = new Map();
vi.stubGlobal("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
});

describe("fontsize", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--editor-font-size");
  });

  it("clampFontSize は範囲内に丸め、不正値は既定値にする", () => {
    expect(clampFontSize(MIN_FONT_SIZE - 5)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(MAX_FONT_SIZE + 5)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize("16")).toBe(16);
    expect(clampFontSize("abc")).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(null)).toBe(DEFAULT_FONT_SIZE); // Number(null) は 0 だが下限ではなく既定値にする
    expect(clampFontSize(15.6)).toBe(16);
  });

  it("未保存なら既定値、保存済みならその値で初期化し CSS 変数に反映する", () => {
    initFontSize();
    expect(getFontSize()).toBe(DEFAULT_FONT_SIZE);
    expect(cssSize()).toBe(`${DEFAULT_FONT_SIZE}px`);

    localStorage.setItem("mymemo.fontSize", "20");
    initFontSize();
    expect(getFontSize()).toBe(20);
    expect(cssSize()).toBe("20px");
  });

  it("保存値が不正なら既定値に戻す", () => {
    localStorage.setItem("mymemo.fontSize", "huge");
    initFontSize();
    expect(getFontSize()).toBe(DEFAULT_FONT_SIZE);
  });

  it("拡大・縮小・リセットが永続化され、コールバックが呼ばれる", () => {
    const calls = [];
    initFontSize((n) => calls.push(n));
    zoomIn();
    zoomIn();
    expect(getFontSize()).toBe(DEFAULT_FONT_SIZE + 2);
    expect(localStorage.getItem("mymemo.fontSize")).toBe(String(DEFAULT_FONT_SIZE + 2));
    zoomOut();
    expect(getFontSize()).toBe(DEFAULT_FONT_SIZE + 1);
    resetFontSize();
    expect(getFontSize()).toBe(DEFAULT_FONT_SIZE);
    expect(calls).toEqual([DEFAULT_FONT_SIZE, DEFAULT_FONT_SIZE + 1, DEFAULT_FONT_SIZE + 2, DEFAULT_FONT_SIZE + 1, DEFAULT_FONT_SIZE]);
  });

  it("上限・下限を超えない", () => {
    applyFontSize(MAX_FONT_SIZE);
    zoomIn();
    expect(getFontSize()).toBe(MAX_FONT_SIZE);
    applyFontSize(MIN_FONT_SIZE);
    zoomOut();
    expect(getFontSize()).toBe(MIN_FONT_SIZE);
  });
});
