import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import {
  normalizeIndent,
  detectIndent,
  describeIndent,
  initIndent,
  getDefaultIndent,
  setDefaultIndent,
  syncIndentMenu,
} from "./indent.js";

// vitest の jsdom 環境には localStorage が無いのでメモリ上のスタブを使う
const store = new Map();
vi.stubGlobal("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
});

describe("normalizeIndent / describeIndent", () => {
  it("不正値は既定値に寄せる", () => {
    expect(normalizeIndent({ tabSize: 2, softTabs: true })).toEqual({ tabSize: 2, softTabs: true });
    expect(normalizeIndent({ tabSize: "8", softTabs: 1 })).toEqual({ tabSize: 8, softTabs: true });
    expect(normalizeIndent({ tabSize: 3 })).toEqual({ tabSize: 4, softTabs: false });
    expect(normalizeIndent(null)).toEqual({ tabSize: 4, softTabs: false });
  });

  it("ラベル", () => {
    expect(describeIndent({ tabSize: 4, softTabs: false })).toBe("タブ幅 4");
    expect(describeIndent({ tabSize: 2, softTabs: true })).toBe("スペース 2");
  });
});

describe("detectIndent", () => {
  const fb = { tabSize: 4, softTabs: false };

  it("字下げが無ければ null", () => {
    expect(detectIndent("", fb)).toBeNull();
    expect(detectIndent("a\nb\n   \n", fb)).toBeNull(); // 空白だけの行は数えない
  });

  it("タブ始まりの行が多ければタブ(幅は既定値)", () => {
    expect(detectIndent("a\n\tb\n\tc\n  d\n", { tabSize: 8, softTabs: true })).toEqual({
      tabSize: 8,
      softTabs: false,
    });
  });

  it("スペース始まりの行が多ければ幅を推定する", () => {
    expect(detectIndent("a\n  b\n    c\n  d\n", fb)).toEqual({ tabSize: 2, softTabs: true });
    expect(detectIndent("a\n    b\n        c\n", fb)).toEqual({ tabSize: 4, softTabs: true });
    expect(detectIndent("a\n        b\n                c\n", fb)).toEqual({ tabSize: 8, softTabs: true });
    // 2 と 4 が同点なら大きい方
    expect(detectIndent("a\n    b\n", fb)).toEqual({ tabSize: 4, softTabs: true });
    // 1 桁の字下げ(コメントの " * " など)は幅の判定に寄与しない
    expect(detectIndent("/*\n * x\n */\n  a\n", fb)).toEqual({ tabSize: 2, softTabs: true });
  });

  it("CRLF / CR の改行でも行を分けて数える", () => {
    expect(detectIndent("a\r\n\tb\r\tc", fb)).toEqual({ tabSize: 4, softTabs: false });
  });

  it("先頭 1000 行だけ見る", () => {
    const text = "\tt\n" + "x\n".repeat(1000) + "  s\n".repeat(50);
    expect(detectIndent(text, fb).softTabs).toBe(false);
  });
});

describe("既定値の永続化とメニュー同期", () => {
  beforeEach(() => {
    store.clear();
    invoke.mockClear();
  });

  it("保存が無ければ既定値、保存済みならそれを復元する", () => {
    initIndent();
    expect(getDefaultIndent()).toEqual({ tabSize: 4, softTabs: false });
    setDefaultIndent({ tabSize: 2, softTabs: true });
    expect(JSON.parse(store.get("mymemo.indent"))).toEqual({ tabSize: 2, softTabs: true });
    initIndent();
    expect(getDefaultIndent()).toEqual({ tabSize: 2, softTabs: true });
    store.set("mymemo.indent", "{broken");
    initIndent();
    expect(getDefaultIndent()).toEqual({ tabSize: 4, softTabs: false });
  });

  it("syncIndentMenu は値が変わったときだけ set_indent を呼ぶ", () => {
    syncIndentMenu({ tabSize: 2, softTabs: true });
    syncIndentMenu({ tabSize: 2, softTabs: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("set_indent", { tabSize: 2, softTabs: true });
    syncIndentMenu({ tabSize: 4, softTabs: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
