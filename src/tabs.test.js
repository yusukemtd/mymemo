import { describe, it, expect, vi, beforeEach } from "vitest";

// Tauri IPC はテスト環境に存在しないためモックする
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

// tabs.js はモジュールロード時に #tabbar を参照し、モジュール変数で状態を持つため
// テストごとに DOM を作り直して再インポートする
async function loadTabs() {
  vi.resetModules();
  document.body.innerHTML = '<div id="tabbar"></div>';
  const tabs = await import("./tabs.js");
  const { EditorState } = await import("@codemirror/state");
  const view = {
    state: EditorState.create({ doc: "" }),
    setState(s) {
      this.state = s;
    },
    dispatch(spec) {
      this.state = this.state.update(spec).state;
    },
    focus() {},
  };
  tabs.initTabs(view);
  return { tabs, view };
}

describe("tabs", () => {
  beforeEach(() => {
    invoke.mockClear();
  });

  it("setEncoding は文字コードを変えて未保存扱いにし、同じ値なら何もしない", async () => {
    const { tabs } = await loadTabs();
    const tab = tabs.newTab("/a.txt", "abc", "UTF-8");
    tabs.setEncoding(tab, "UTF-8");
    expect(tab.dirty).toBe(false);
    tabs.setEncoding(tab, "CP932");
    expect(tab.encoding).toBe("CP932");
    expect(tab.dirty).toBe(true);
    expect(tabs.stateOf(tab).doc.toString()).toBe("abc"); // 本文は変わらない
  });

  it("開いた内容の字下げからインデント設定を判定し、setIndent で変えられる", async () => {
    const { tabs, view } = await loadTabs();
    const { indentOf } = await import("./editor.js");
    const soft = tabs.newTab("/soft.py", "def f():\n  return 1\n");
    expect(soft.indent).toEqual({ tabSize: 2, softTabs: true });
    expect(indentOf(view.state)).toEqual({ tabSize: 2, softTabs: true });
    const hard = tabs.newTab("/hard.go", "func f() {\n\treturn\n}\n");
    expect(hard.indent).toEqual({ tabSize: 4, softTabs: false });
    expect(tabs.newTab().indent).toEqual({ tabSize: 4, softTabs: false }); // 判定できなければ既定値

    tabs.setIndent(soft, { tabSize: 8, softTabs: true }); // 非アクティブタブにも効く
    expect(indentOf(tabs.stateOf(soft))).toEqual({ tabSize: 8, softTabs: true });
    tabs.activate(1);
    expect(indentOf(view.state)).toEqual({ tabSize: 8, softTabs: true });
  });

  it("初期化で無題タブが1つ作られる", async () => {
    const { tabs } = await loadTabs();
    expect(tabs.getTabs()).toHaveLength(1);
    expect(tabs.getActiveTab().name).toBe("無題-1");
    expect(tabs.getActiveTab().dirty).toBe(false);
  });

  it("無題タブの連番はパス付きタブでは進まない", async () => {
    const { tabs } = await loadTabs();
    tabs.newTab("/path/to/file.txt", "hello");
    tabs.newTab();
    expect(tabs.getTabs().map((t) => t.name)).toEqual([
      "無題-1",
      "file.txt",
      "無題-2",
    ]);
  });

  it("findTabByPath はパスの一致するタブの index を返す", async () => {
    const { tabs } = await loadTabs();
    tabs.newTab("/a/b.txt", "x");
    expect(tabs.findTabByPath("/a/b.txt")).toBe(1);
    expect(tabs.findTabByPath("/nope")).toBe(-1);
  });

  it("activate でビューの内容がタブの state に切り替わる", async () => {
    const { tabs, view } = await loadTabs();
    tabs.newTab("/a/one.txt", "ONE");
    tabs.newTab("/a/two.txt", "TWO");
    tabs.activate(1);
    expect(view.state.doc.toString()).toBe("ONE");
    tabs.activate(2);
    expect(view.state.doc.toString()).toBe("TWO");
  });

  it("cycleTab は末尾から先頭へ循環する", async () => {
    const { tabs } = await loadTabs();
    tabs.newTab("/a/one.txt", "1");
    tabs.newTab("/a/two.txt", "2"); // active = index 2
    tabs.cycleTab(1);
    expect(tabs.getActiveTab().name).toBe("無題-1");
    tabs.cycleTab(-1);
    expect(tabs.getActiveTab().name).toBe("two.txt");
  });

  it("closeTab: 未保存タブは確認で拒否されると閉じない", async () => {
    const { tabs } = await loadTabs();
    tabs.newTab("/a/one.txt", "1");
    tabs.getActiveTab().dirty = true;
    await tabs.closeTab(1, async () => false);
    expect(tabs.getTabs()).toHaveLength(2);
    await tabs.closeTab(1, async () => true);
    expect(tabs.getTabs()).toHaveLength(1);
  });

  it("closeTab: アクティブより前のタブを閉じると activeIndex がずれない", async () => {
    const { tabs, view } = await loadTabs();
    tabs.newTab("/a/one.txt", "ONE");
    tabs.newTab("/a/two.txt", "TWO"); // active
    await tabs.closeTab(0, null);
    expect(tabs.getActiveTab().name).toBe("two.txt");
    expect(view.state.doc.toString()).toBe("TWO");
  });

  it("closeTab: 最後のタブを閉じるとアプリ終了を要求する", async () => {
    const { tabs } = await loadTabs();
    await tabs.closeTab(0, null);
    expect(invoke).toHaveBeenCalledWith("quit_app");
  });

  it("closeTab: quitIfLast=false なら終了せず新しい無題タブを作る", async () => {
    const { tabs } = await loadTabs();
    await tabs.closeTab(0, null, false);
    expect(invoke).not.toHaveBeenCalled();
    expect(tabs.getTabs()).toHaveLength(1);
    expect(tabs.getActiveTab().name).toBe("無題-2");
  });

  it("replaceActiveTab は無題タブをファイル内容で置き換える(改行コードは行ごとに保持)", async () => {
    const { tabs, view } = await loadTabs();
    const { docWithLineEndings } = await import("./editor.js");
    tabs.replaceActiveTab("/a/doc.md", "# hi\r\nbody\n", "CP932");
    const t = tabs.getActiveTab();
    expect(t.name).toBe("doc.md");
    expect(t.encoding).toBe("CP932");
    expect(t.dirty).toBe(false);
    expect(view.state.doc.toString()).toBe("# hi\nbody\n");
    expect(docWithLineEndings(view.state)).toBe("# hi\r\nbody\n");
  });

  it("convertLineEndings は改行コードが変わったときだけ非アクティブタブも未保存にする", async () => {
    const { tabs } = await loadTabs();
    const { docWithLineEndings } = await import("./editor.js");
    const mixed = tabs.newTab("/tmp/mixed.txt", "a\r\nb\n");
    const lf = tabs.newTab("/tmp/lf.txt", "a\nb\n"); // こちらがアクティブになる
    tabs.convertLineEndings(mixed, "CRLF");
    expect(docWithLineEndings(tabs.stateOf(mixed))).toBe("a\r\nb\r\n");
    expect(mixed.dirty).toBe(true);
    tabs.convertLineEndings(lf, "LF"); // 既に LF なので変化なし
    expect(lf.dirty).toBe(false);
  });

  it("markSaved は dirty を解除し、別名保存でタブ名を更新する", async () => {
    const { tabs } = await loadTabs();
    tabs.getActiveTab().dirty = true;
    tabs.markSaved(tabs.getActiveTab(), "/a/saved.txt");
    const t = tabs.getActiveTab();
    expect(t.dirty).toBe(false);
    expect(t.name).toBe("saved.txt");
    expect(t.path).toBe("/a/saved.txt");
  });

  it("markSaved は保存中にタブが切り替わっても渡されたタブへ反映する", async () => {
    const { tabs } = await loadTabs();
    const saved = tabs.newTab("/a/one.txt", "1");
    saved.dirty = true;
    tabs.activate(0); // 保存待ちの間に別タブへ切り替わった想定
    tabs.markSaved(saved, "/a/renamed.txt");
    expect(saved.dirty).toBe(false);
    expect(saved.name).toBe("renamed.txt");
    expect(tabs.getActiveTab().name).toBe("無題-1"); // アクティブタブは無関係のまま
  });

  it("非アクティブタブを閉じてもアクティブタブの未同期編集が失われない", async () => {
    const { tabs, view } = await loadTabs();
    tabs.newTab("/a/one.txt", "ONE"); // index 1, active
    // タブ切替なしで編集(tab.state は未同期の状態)
    view.dispatch({ changes: { from: 3, insert: "-edited" } });
    await tabs.closeTab(0, null);
    expect(view.state.doc.toString()).toBe("ONE-edited");
  });

  it("タブバーの DOM にアクティブ・dirty 状態が反映される", async () => {
    const { tabs } = await loadTabs();
    tabs.newTab("/a/one.txt", "1");
    tabs.getActiveTab().dirty = true;
    tabs.render();
    const els = document.querySelectorAll("#tabbar .tab");
    expect(els).toHaveLength(2);
    expect(els[0].classList.contains("active")).toBe(false);
    expect(els[1].classList.contains("active")).toBe(true);
    expect(els[1].classList.contains("dirty")).toBe(true);
  });
});
