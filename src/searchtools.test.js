import { describe, it, expect, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { SearchQuery, setSearchQuery, openSearchPanel } from "@codemirror/search";
import { createEditorState } from "./editor.js";
import {
  expandReplacement,
  countMatches,
  currentMatchIndex,
  describeMatches,
  replaceInSelection,
} from "./searchtools.js";

const q = (spec) => new SearchQuery({ search: "", replace: "", ...spec });
const mk = (doc, spec, sel) => {
  const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
  view.dispatch({ effects: setSearchQuery.of(q(spec)), selection: sel });
  return view;
};

describe("expandReplacement", () => {
  it("通常の検索は \\n などのエスケープだけ解釈する", () => {
    expect(expandReplacement(q({ search: "a", replace: "x\\ty$1" }), { match: null })).toBe("x\ty$1");
  });

  it("literal ならそのまま", () => {
    expect(expandReplacement(q({ search: "a", replace: "x\\ny", literal: true }), {})).toBe("x\\ny");
  });

  it("正規表現は $1 / $& / $$ を展開し、無いグループはそのまま", () => {
    const query = q({ search: "(a)(b)?", replace: "[$1|$2|$&|$$|$9]", regexp: true });
    const match = ["a", "a", undefined];
    expect(expandReplacement(query, { match })).toBe("[a|undefined|a|$|$9]");
    const m2 = Object.assign(["ab", "a", "b"], {});
    expect(expandReplacement(q({ search: "(a)(b)", replace: "$2$1$10", regexp: true }), { match: m2 })).toBe("ba" + "a0");
  });
});

describe("countMatches / currentMatchIndex / describeMatches", () => {
  it("一致範囲を集め、上限で打ち切る", () => {
    const state = createEditorState("ab ab ab", () => {});
    const query = q({ search: "ab" });
    expect(countMatches(state, query)).toEqual({
      ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }, { from: 6, to: 8 }],
      truncated: false,
    });
    expect(countMatches(state, query, 2)).toEqual({ ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }], truncated: true });
    expect(countMatches(state, q({ search: "(", regexp: true }))).toEqual({ ranges: [], truncated: false });
    expect(countMatches(state, q({ search: "" }))).toEqual({ ranges: [], truncated: false });
  });

  it("選択が一致と一致していれば番号を返す", () => {
    const ranges = [{ from: 0, to: 2 }, { from: 3, to: 5 }, { from: 6, to: 8 }];
    expect(currentMatchIndex(ranges, { from: 3, to: 5 })).toBe(2);
    expect(currentMatchIndex(ranges, { from: 6, to: 8 })).toBe(3);
    expect(currentMatchIndex(ranges, { from: 3, to: 4 })).toBe(0);
    expect(currentMatchIndex(ranges, { from: 9, to: 9 })).toBe(0);
    expect(currentMatchIndex([], { from: 0, to: 0 })).toBe(0);
  });

  it("表示文字列", () => {
    const m = { ranges: [{ from: 0, to: 2 }, { from: 3, to: 5 }], truncated: false };
    expect(describeMatches(q({ search: "ab" }), m, { from: 3, to: 5 })).toBe("2 / 2 件");
    expect(describeMatches(q({ search: "ab" }), m, { from: 1, to: 1 })).toBe("2 件");
    expect(describeMatches(q({ search: "" }), { ranges: [], truncated: false }, { from: 0, to: 0 })).toBe("");
    expect(describeMatches(q({ search: "x" }), { ranges: [], truncated: false }, { from: 0, to: 0 })).toBe("0 件");
    const many = { ranges: Array.from({ length: 10000 }, (_, i) => ({ from: i, to: i })), truncated: true };
    expect(describeMatches(q({ search: "x" }), many, { from: 0, to: 0 })).toBe("10,000+ 件");
  });
});

describe("replaceInSelection", () => {
  it("選択範囲の中だけ置換し、選択は置換後も範囲を覆う", () => {
    const view = mk("ab ab ab ab", { search: "ab", replace: "XYZ" }, { anchor: 3, head: 8 });
    expect(replaceInSelection(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("ab XYZ XYZ ab");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([3, 10]);
    view.destroy();
  });

  it("複数選択の各範囲を対象にし、正規表現のグループも展開する", () => {
    const view = mk("a1 a2 a3 a4", { search: "a(\\d)", replace: "$1a", regexp: true });
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(9, 11)]),
    });
    expect(replaceInSelection(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("1a a2 a3 4a");
    view.destroy();
  });

  it("選択が無い・一致が無い・正規表現が不正なら何もしない", () => {
    const view = mk("ab ab", { search: "ab", replace: "x" }, { anchor: 1 });
    expect(replaceInSelection(view)).toBe(false);
    view.dispatch({ selection: { anchor: 0, head: 5 }, effects: setSearchQuery.of(q({ search: "zz", replace: "x" })) });
    expect(replaceInSelection(view)).toBe(false);
    view.dispatch({ effects: setSearchQuery.of(q({ search: "(", replace: "x", regexp: true })) });
    expect(replaceInSelection(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("ab ab");
    view.destroy();
  });
});

describe("検索パネルの件数表示", () => {
  it("検索語・本文・選択の変化に追従する", async () => {
    vi.useFakeTimers();
    const view = new EditorView({ state: createEditorState("ab ab ab", () => {}), parent: document.body });
    openSearchPanel(view);
    const countEl = () => view.dom.querySelector(".mm-search-count").textContent;
    expect(countEl()).toBe("");

    const input = view.dom.querySelector(".mm-search input");
    input.value = "ab";
    input.dispatchEvent(new Event("input"));
    vi.advanceTimersByTime(200);
    expect(countEl()).toBe("3 件");

    view.dispatch({ selection: { anchor: 3, head: 5 } });
    expect(countEl()).toBe("2 / 3 件");

    view.dispatch({ changes: { from: 0, to: 2, insert: "zz" } });
    vi.advanceTimersByTime(200);
    expect(countEl()).toBe("1 / 2 件");
    vi.useRealTimers();
    view.destroy();
  });
});
