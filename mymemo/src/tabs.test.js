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

  it("replaceActiveTab は無題タブをファイル内容で置き換える", async () => {
    const { tabs, view } = await loadTabs();
    tabs.replaceActiveTab("/a/doc.md", "# hi", "CP932", "CRLF");
    const t = tabs.getActiveTab();
    expect(t.name).toBe("doc.md");
    expect(t.encoding).toBe("CP932");
    expect(t.lineEnding).toBe("CRLF");
    expect(t.dirty).toBe(false);
    expect(view.state.doc.toString()).toBe("# hi");
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
