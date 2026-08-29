import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { invoke } from "@tauri-apps/api/core";
import {
  pushRecent,
  initRecentFiles,
  addRecentFile,
  removeRecentFile,
  clearRecentFiles,
  getRecentFiles,
  MAX_RECENT,
} from "./recent.js";

// vitest の jsdom 環境には localStorage が無いのでメモリ上のスタブを使う
const store = new Map();
vi.stubGlobal("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
});

const lastMenuPaths = () => invoke.mock.calls.at(-1)[1].paths;

describe("pushRecent", () => {
  it("先頭に追加し、重複は先頭へ移し、上限で切る", () => {
    expect(pushRecent([], "/a")).toEqual(["/a"]);
    expect(pushRecent(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
    expect(pushRecent(["/a", "/b", "/c"], "/b")).toEqual(["/b", "/a", "/c"]);
    const full = Array.from({ length: MAX_RECENT }, (_, i) => `/f${i}`);
    const pushed = pushRecent(full, "/new");
    expect(pushed).toHaveLength(MAX_RECENT);
    expect(pushed[0]).toBe("/new");
    expect(pushed).not.toContain(`/f${MAX_RECENT - 1}`);
  });
});

describe("recent files", () => {
  beforeEach(() => {
    store.clear();
    invoke.mockClear();
  });

  it("保存済み履歴を復元してメニューに反映する。壊れていれば空", () => {
    store.set("mymemo.recentFiles", JSON.stringify(["/a.txt", 42, "/b.txt"]));
    initRecentFiles();
    expect(getRecentFiles()).toEqual(["/a.txt", "/b.txt"]);
    expect(invoke).toHaveBeenCalledWith("set_recent_files", { paths: ["/a.txt", "/b.txt"] });

    store.set("mymemo.recentFiles", "{broken");
    initRecentFiles();
    expect(getRecentFiles()).toEqual([]);
    expect(lastMenuPaths()).toEqual([]);
  });

  it("追加・削除・消去が永続化とメニューに反映される", () => {
    initRecentFiles();
    addRecentFile("/a.txt");
    addRecentFile("/b.txt");
    addRecentFile("/a.txt");
    expect(getRecentFiles()).toEqual(["/a.txt", "/b.txt"]);
    expect(JSON.parse(store.get("mymemo.recentFiles"))).toEqual(["/a.txt", "/b.txt"]);
    expect(lastMenuPaths()).toEqual(["/a.txt", "/b.txt"]);

    const before = invoke.mock.calls.length;
    removeRecentFile("/none.txt"); // 無いものは何もしない
    expect(invoke.mock.calls.length).toBe(before);
    removeRecentFile("/a.txt");
    expect(getRecentFiles()).toEqual(["/b.txt"]);
    expect(lastMenuPaths()).toEqual(["/b.txt"]);

    clearRecentFiles();
    expect(getRecentFiles()).toEqual([]);
    expect(store.get("mymemo.recentFiles")).toBe("[]");
    expect(lastMenuPaths()).toEqual([]);
  });

  it("getRecentFiles はコピーを返す", () => {
    initRecentFiles();
    addRecentFile("/a.txt");
    getRecentFiles().push("/x");
    expect(getRecentFiles()).toEqual(["/a.txt"]);
  });
});
