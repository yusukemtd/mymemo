import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

// vitest の jsdom 環境には localStorage が無いのでメモリ上のスタブを使う
const store = new Map();
vi.stubGlobal("localStorage", {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
});

// toggles.js は tabs.js(#tabbar とモジュール変数)に依存するため、テストごとに DOM を作り直して再インポートする
async function load() {
  vi.resetModules();
  document.body.innerHTML = '<div id="tabbar"></div>';
  const { invoke } = await import("@tauri-apps/api/core");
  const tabs = await import("./tabs.js");
  const toggles = await import("./toggles.js");
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
  invoke.mockClear();
  return { invoke, tabs, toggles, view };
}

describe("createToggle", () => {
  beforeEach(() => store.clear());

  it("init は保存値(無ければ既定値)を復元してメニューへ同期する", async () => {
    const { invoke, toggles } = await load();
    const calls = [];
    const setter = vi.fn((v) => () => calls.push(v));
    const t = toggles.createToggle({ id: "toggle_x", storageKey: "x", setter, defaultValue: true });
    t.init();
    expect(t.get()).toBe(true);
    expect(setter).toHaveBeenCalledWith(true);
    expect(invoke).toHaveBeenCalledWith("set_toggle", { id: "toggle_x", on: true });

    store.set("x", "0");
    t.init();
    expect(t.get()).toBe(false);
  });

  it("apply / toggle は永続化し、全タブへ reconfigure を配ってメニューへ同期する", async () => {
    const { invoke, toggles, tabs } = await load();
    tabs.newTab("/a.txt", "a"); // 非アクティブになる無題タブと 2 つ
    const applied = [];
    const setter = (v) => () => {
      applied.push(v);
      return []; // reconfigure の代わりに空のエフェクト
    };
    const t = toggles.createToggle({ id: "toggle_x", storageKey: "x", setter, defaultValue: false });
    t.toggle();
    expect(t.get()).toBe(true);
    expect(store.get("x")).toBe("1");
    expect(applied).toEqual([true, true]); // タブ 2 つぶん
    expect(invoke).toHaveBeenLastCalledWith("set_toggle", { id: "toggle_x", on: true });
    t.apply(false);
    expect(store.get("x")).toBe("0");
  });

  it("既定の設定は空白文字表示(ON)と折り返し(OFF)で、ID から引ける", async () => {
    const { toggles } = await load();
    expect(toggles.TOGGLES.toggle_whitespace).toBe(toggles.showWhitespace);
    expect(toggles.TOGGLES.toggle_wrap).toBe(toggles.lineWrap);
    toggles.showWhitespace.init();
    toggles.lineWrap.init();
    expect(toggles.showWhitespace.get()).toBe(true);
    expect(toggles.lineWrap.get()).toBe(false);
  });
});
