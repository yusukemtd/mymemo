import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// vitest の jsdom 環境には localStorage が無いのでメモリ上のスタブを使う
const store = new Map();
vi.stubGlobal("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
});

// tabs.js / session.js はモジュール変数で状態を持つため、テストごとに DOM を作り直して再インポートする
async function load({ initialTab = true } = {}) {
  vi.resetModules();
  document.body.innerHTML = '<div id="tabbar"></div>';
  const tabs = await import("./tabs.js");
  const session = await import("./session.js");
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
  tabs.initTabs(view, { initialTab });
  return { tabs, session, view };
}

describe("snapshotSession", () => {
  beforeEach(() => store.clear());

  it("パス付きタブはパスと文字コードとカーソル、無題タブは本文を保存し、空の無題タブは残さない", async () => {
    const { tabs, session, view } = await load();
    tabs.newTab("/a.txt", "hello\nworld", "CP932");
    view.dispatch({ selection: { anchor: 8, head: 6 } });
    tabs.newTab(null, "下書き");
    tabs.newTab(); // 空の無題タブ(アクティブ)
    const snap = session.snapshotSession(tabs.getTabs(), 3, tabs.stateOf);
    expect(snap.tabs).toEqual([
      { path: "/a.txt", encoding: "CP932", draft: null, cursor: { anchor: 8, head: 6 } },
      { path: null, encoding: "UTF-8", draft: "下書き", cursor: { anchor: 0, head: 0 } },
    ]);
    // アクティブだった空タブは除かれたので末尾を指す
    expect(snap.active).toBe(1);
  });

  it("アクティブタブの index は除外分を詰めた後の位置になる", async () => {
    const { tabs, session } = await load();
    tabs.newTab("/a.txt", "a");
    tabs.newTab("/b.txt", "b");
    tabs.activate(2); // /b.txt。先頭の空の無題タブが除かれるので 1 になる
    const snap = session.snapshotSession(tabs.getTabs(), 2, tabs.stateOf);
    expect(snap.tabs.map((t) => t.path)).toEqual(["/a.txt", "/b.txt"]);
    expect(snap.active).toBe(1);
  });
});

describe("parseSession", () => {
  it("無い・壊れている・別バージョンは null", async () => {
    const { session } = await load();
    expect(session.parseSession(null)).toBeNull();
    expect(session.parseSession("{oops")).toBeNull();
    expect(session.parseSession(JSON.stringify({ version: 99, tabs: [] }))).toBeNull();
    expect(session.parseSession(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it("欠けた項目は既定値で補い、不正な要素は除き、active は範囲内に丸める", async () => {
    const { session } = await load();
    const parsed = session.parseSession(
      JSON.stringify({
        version: 1,
        active: 10,
        tabs: [{ path: "/a.txt" }, { draft: "memo", cursor: { anchor: "x" } }, null, { name: "bad" }],
      })
    );
    expect(parsed.tabs).toEqual([
      { path: "/a.txt", encoding: "UTF-8", draft: null, cursor: { anchor: 0, head: 0 } },
      { path: null, encoding: "UTF-8", draft: "memo", cursor: { anchor: 0, head: 0 } },
    ]);
    expect(parsed.active).toBe(1);
  });
});

describe("restoreSession", () => {
  beforeEach(() => store.clear());

  it("読めるファイルと下書きを復元し、読めないファイルは飛ばし、アクティブタブとカーソルを戻す", async () => {
    const { tabs, session } = await load({ initialTab: false });
    const readFile = vi.fn(async (path, encoding) => {
      if (path === "/gone.txt") throw new Error("no such file");
      return { content: `content of ${path}`, encoding: encoding ?? "CP932" }; // null = 自動判定
    });
    const n = await session.restoreSession(readFile, {
      version: 1,
      active: 2,
      tabs: [
        { path: "/a.txt", encoding: "CP932", draft: null, cursor: { anchor: 3, head: 3 } },
        { path: "/gone.txt", encoding: "UTF-8", draft: null, cursor: { anchor: 0, head: 0 } },
        { path: null, encoding: "UTF-8", draft: "メモ", cursor: { anchor: 999, head: 999 } },
      ],
    });
    expect(n).toBe(2);
    const list = tabs.getTabs();
    expect(list.map((t) => t.name)).toEqual(["a.txt", "無題-1"]);
    expect(list[0].encoding).toBe("CP932");
    expect(list[0].dirty).toBe(false);
    expect(list[1].dirty).toBe(true); // 下書きは未保存扱い
    expect(tabs.getActiveTab()).toBe(list[1]);
    expect(tabs.stateOf(list[0]).selection.main.head).toBe(3);
    expect(tabs.stateOf(list[1]).selection.main.head).toBe(2); // 本文長で丸める
    expect(readFile).toHaveBeenCalledWith("/a.txt", null); // 保存された文字コードでは読み直さない(自動判定)
  });

  it("セッションが無ければ何もしない", async () => {
    const { tabs, session } = await load({ initialTab: false });
    expect(await session.restoreSession(vi.fn())).toBe(0);
    expect(tabs.getTabs()).toHaveLength(0);
  });

  it("saveSession → restoreSession で往復できる", async () => {
    const first = await load();
    first.tabs.newTab(null, "残したいメモ");
    first.view.dispatch({ selection: { anchor: 3 } });
    expect(first.session.saveSession()).toBe(true);

    const second = await load({ initialTab: false });
    await second.session.restoreSession(vi.fn());
    const [tab] = second.tabs.getTabs();
    expect(second.tabs.stateOf(tab).doc.toString()).toBe("残したいメモ");
    expect(second.tabs.stateOf(tab).selection.main.head).toBe(3);
    expect(tab.dirty).toBe(true);
  });

  it("localStorage に書けなければ false を返す", async () => {
    const { session } = await load();
    const orig = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    try {
      expect(session.saveSession()).toBe(false);
    } finally {
      localStorage.setItem = orig;
    }
  });
});
