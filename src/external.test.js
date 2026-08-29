import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// tabs.js / external.js はモジュール変数で状態を持つため、テストごとに DOM を作り直して再インポートする
async function load() {
  vi.resetModules();
  document.body.innerHTML = '<div id="tabbar"></div>';
  const tabs = await import("./tabs.js");
  const external = await import("./external.js");
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
  tabs.initTabs(view, { initialTab: false });
  return { tabs, external, view };
}

describe("classify / needsOverwriteConfirm", () => {
  it("フォーカス時の判定", async () => {
    const { external } = await load();
    const tab = { path: "/a.txt", mtime: 100, dirty: false };
    expect(external.classify(tab, 100)).toBe("none");
    expect(external.classify(tab, 200)).toBe("reload");
    expect(external.classify({ ...tab, dirty: true }, 200)).toBe("ask");
    expect(external.classify({ ...tab, mtime: null }, 200)).toBe("none"); // 確認済み
    expect(external.classify(tab, null)).toBe("none"); // ディスクから消えた
    expect(external.classify({ path: null, mtime: null, dirty: true }, 200)).toBe("none"); // 無題
  });

  it("保存前の判定", async () => {
    const { external } = await load();
    expect(external.needsOverwriteConfirm({ mtime: 100 }, 100)).toBe(false);
    expect(external.needsOverwriteConfirm({ mtime: 100 }, 200)).toBe(true);
    expect(external.needsOverwriteConfirm({ mtime: null }, 200)).toBe(true); // 確認済みでも保存時は聞く
    expect(external.needsOverwriteConfirm({ mtime: 100 }, null)).toBe(false); // 消えていればそのまま書く
  });
});

describe("checkExternalChanges", () => {
  function deps({ disk = {}, files = {}, answer = true } = {}) {
    return {
      fileMtime: vi.fn(async (path) => {
        if (disk[path] instanceof Error) throw disk[path];
        return disk[path] ?? null;
      }),
      readFile: vi.fn(async (path, encoding) => ({ content: files[path], encoding, mtime: disk[path] })),
      confirm: vi.fn(async () => answer),
    };
  }

  it("未編集のタブは黙って読み直し、カーソル位置は本文長の範囲で保つ", async () => {
    const { tabs, external, view } = await load();
    const tab = tabs.newTab("/a.txt", "old content", "UTF-8", 100);
    view.dispatch({ selection: { anchor: 9 } });
    const d = deps({ disk: { "/a.txt": 200 }, files: { "/a.txt": "new" } });
    await external.checkExternalChanges(d);
    expect(view.state.doc.toString()).toBe("new");
    expect(view.state.selection.main.head).toBe(3);
    expect(tab.mtime).toBe(200);
    expect(tab.dirty).toBe(false);
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("編集中のタブは確認し、拒否したら内容を保って mtime を null にする(聞き直さない)", async () => {
    const { tabs, external, view } = await load();
    const tab = tabs.newTab("/a.txt", "old", "UTF-8", 100);
    view.dispatch({ changes: { from: 3, insert: "!" } });
    tabs.markDirtyTab(tab); // 偽 view では updateListener が動かないので明示的に未保存にする
    const d = deps({ disk: { "/a.txt": 200 }, files: { "/a.txt": "new" }, answer: false });
    await external.checkExternalChanges(d);
    expect(view.state.doc.toString()).toBe("old!");
    expect(tab.mtime).toBeNull();
    expect(d.confirm).toHaveBeenCalledTimes(1);

    await external.checkExternalChanges(d);
    expect(d.confirm).toHaveBeenCalledTimes(1);
  });

  it("編集中のタブで承諾したら読み直して未保存が消える", async () => {
    const { tabs, external, view } = await load();
    const tab = tabs.newTab("/a.txt", "old", "UTF-8", 100);
    view.dispatch({ changes: { from: 3, insert: "!" } });
    tabs.markDirtyTab(tab);
    await external.checkExternalChanges(deps({ disk: { "/a.txt": 200 }, files: { "/a.txt": "new" } }));
    expect(view.state.doc.toString()).toBe("new");
    expect(tab.dirty).toBe(false);
  });

  it("変更なし・無題・消えたファイル・時刻が取れないファイルは触らない。非アクティブタブも確認する", async () => {
    const { tabs, external, view } = await load();
    const same = tabs.newTab("/same.txt", "same", "UTF-8", 100);
    const gone = tabs.newTab("/gone.txt", "gone", "UTF-8", 100);
    const broken = tabs.newTab("/broken.txt", "broken", "UTF-8", 100);
    const changed = tabs.newTab("/changed.txt", "changed", "UTF-8", 100);
    tabs.newTab(null, "draft");
    const d = deps({
      disk: { "/same.txt": 100, "/broken.txt": new Error("EACCES"), "/changed.txt": 300 },
      files: { "/changed.txt": "changed on disk" },
    });
    await external.checkExternalChanges(d);
    expect(tabs.stateOf(same).doc.toString()).toBe("same");
    expect(tabs.stateOf(gone).doc.toString()).toBe("gone");
    expect(tabs.stateOf(broken).doc.toString()).toBe("broken");
    expect(tabs.stateOf(changed).doc.toString()).toBe("changed on disk");
    expect(changed.mtime).toBe(300);
    expect(d.fileMtime).not.toHaveBeenCalledWith(null);
    expect(view.state.doc.toString()).toBe("draft"); // アクティブな無題タブはそのまま
  });

  it("読み直しに失敗しても他のタブの確認は続く", async () => {
    const { tabs, external } = await load();
    const a = tabs.newTab("/a.txt", "a", "UTF-8", 100);
    const b = tabs.newTab("/b.txt", "b", "UTF-8", 100);
    const d = deps({ disk: { "/a.txt": 200, "/b.txt": 200 }, files: { "/b.txt": "b2" } });
    d.readFile = vi.fn(async (path, encoding) => {
      if (path === "/a.txt") throw new Error("read error");
      return { content: "b2", encoding, mtime: 200 };
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await external.checkExternalChanges(d);
    spy.mockRestore();
    expect(tabs.stateOf(a).doc.toString()).toBe("a");
    expect(tabs.stateOf(b).doc.toString()).toBe("b2");
  });
});

describe("reloadTab", () => {
  it("読めなければ例外を投げ、タブは変えない", async () => {
    const { tabs, external, view } = await load();
    const tab = tabs.newTab("/a.txt", "keep", "UTF-8", 100);
    await expect(external.reloadTab(tab, async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    expect(view.state.doc.toString()).toBe("keep");
    expect(tab.mtime).toBe(100);
  });
});
