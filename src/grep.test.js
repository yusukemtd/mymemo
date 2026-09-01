import { describe, it, expect, vi } from "vitest";

// Tauri IPC・ダイアログはテスト環境に存在しないためモックする
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
}));

import { open } from "@tauri-apps/plugin-dialog";

// grep.js はモジュールロード時にパネルの DOM を参照し、モジュール変数で状態を持つため
// テストごとに DOM を作り直して再インポートする
async function loadGrep(activeFilePath) {
  vi.resetModules();
  document.body.innerHTML = `
    <div id="grep-panel" class="hidden">
      <button id="grep-dir-btn"></button>
      <span id="grep-dir-label">フォルダ未選択</span>
      <input id="grep-input" />
      <input id="grep-glob" />
      <input id="grep-replace" />
      <button id="grep-replace-all"></button>
      <input type="checkbox" id="grep-regex" />
      <input type="checkbox" id="grep-case" />
      <button id="grep-run"></button>
      <span id="grep-status"></span>
      <div id="grep-results"></div>
      <button id="grep-close"></button>
    </div>`;
  const grep = await import("./grep.js");
  grep.initGrep(() => {}, { activeFilePath });
  return grep;
}

const dirLabel = () => document.getElementById("grep-dir-label").textContent;

describe("parseGlobs", () => {
  it("空白・カンマ区切りで分割し、空要素を除く", async () => {
    const { parseGlobs } = await loadGrep(() => null);
    expect(parseGlobs("*.md !node_modules, src/**/*.js")).toEqual([
      "*.md",
      "!node_modules",
      "src/**/*.js",
    ]);
    expect(parseGlobs("")).toEqual([]);
  });
});

describe("dirnameOf", () => {
  it("ファイルパスから親フォルダを返す", async () => {
    const { dirnameOf } = await loadGrep(() => null);
    expect(dirnameOf("/a/b/c.txt")).toBe("/a/b");
    expect(dirnameOf("/c.txt")).toBe("/");
    expect(dirnameOf(null)).toBe(null);
    expect(dirnameOf("noslash")).toBe(null);
  });
});

describe("検索フォルダの既定", () => {
  it("パネルを開いたときアクティブなファイルの場所が既定になり、開くたびに追従する", async () => {
    let path = "/proj/src/a.txt";
    const grep = await loadGrep(() => path);
    grep.toggleGrep();
    expect(dirLabel()).toBe("/proj/src");
    grep.toggleGrep(); // 閉じる
    path = "/other/b.md";
    grep.toggleGrep();
    expect(dirLabel()).toBe("/other");
  });

  it("無題タブでは変えず、フォルダを選んだ後は追従しない", async () => {
    let path = null;
    const grep = await loadGrep(() => path);
    grep.toggleGrep();
    expect(dirLabel()).toBe("フォルダ未選択"); // 無題タブのまま開いても変えない
    grep.toggleGrep();
    open.mockResolvedValue("/picked");
    document.getElementById("grep-dir-btn").click();
    await vi.waitFor(() => expect(dirLabel()).toBe("/picked"));
    path = "/proj/src/a.txt";
    grep.toggleGrep();
    expect(dirLabel()).toBe("/picked"); // 手動選択が優先
  });
});
