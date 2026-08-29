import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { createEditorState } from "./editor.js";
import { transformLines, lineRangeForSelection, applyLineTransform } from "./transform.js";

describe("transformLines", () => {
  it("ソートはコードポイント順で安定", () => {
    expect(transformLines(["b", "a", "B", "あ", "10", "9"], "sort_asc")).toEqual(["10", "9", "B", "a", "b", "あ"]);
    expect(transformLines(["b", "a", "B"], "sort_desc")).toEqual(["b", "a", "B"]);
  });

  it("重複削除は最初の 1 つを残す", () => {
    expect(transformLines(["a", "b", "a", "", "", "b"], "unique")).toEqual(["a", "b", ""]);
  });

  it("空行削除は空白だけの行も消す", () => {
    expect(transformLines(["a", "", "  ", "\t", "b"], "remove_blank")).toEqual(["a", "b"]);
  });

  it("未知の変換は例外", () => {
    expect(() => transformLines([], "nope")).toThrow();
  });
});

describe("lineRangeForSelection", () => {
  const state = (doc, sel) => createEditorState(doc, () => {}).update({ selection: sel }).state;
  const doc = "aa\nbb\ncc\ndd";

  it("選択が無ければ全文", () => {
    expect(lineRangeForSelection(state(doc, { anchor: 4 }))).toEqual({ from: 0, to: 11 });
  });

  it("選択にかかる行を行頭〜行末+直後の改行まで広げる", () => {
    expect(lineRangeForSelection(state(doc, { anchor: 1, head: 4 }))).toEqual({ from: 0, to: 6 });
  });

  it("選択の終端が行頭ならその行は含めない。最終行なら改行の拡張は無い", () => {
    expect(lineRangeForSelection(state(doc, { anchor: 3, head: 6 }))).toEqual({ from: 3, to: 6 });
    expect(lineRangeForSelection(state(doc, { anchor: 7, head: 10 }))).toEqual({ from: 6, to: 11 });
  });
});

describe("applyLineTransform", () => {
  const mk = (doc, sel) => {
    const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
    if (sel) view.dispatch({ selection: sel });
    return view;
  };

  it("全文ソートでは終端改行と末尾の空行を動かさない", () => {
    const view = mk("b\na\n");
    expect(applyLineTransform(view, "sort_asc")).toBe(true);
    expect(view.state.doc.toString()).toBe("a\nb\n");
    view.destroy();
    const v2 = mk("b\na");
    applyLineTransform(v2, "sort_desc");
    expect(v2.state.doc.toString()).toBe("b\na");
    expect(applyLineTransform(v2, "sort_desc")).toBe(false); // 変化なし
    v2.destroy();
  });

  it("選択範囲の行だけを対象にし、結果を選択する", () => {
    const view = mk("x\nc\nb\na\ny", { anchor: 3, head: 7 }); // "c\nb\na" のうち c の途中〜a の途中
    applyLineTransform(view, "sort_asc");
    expect(view.state.doc.toString()).toBe("x\na\nb\nc\ny");
    expect([view.state.selection.main.from, view.state.selection.main.to]).toEqual([2, 7]);
    view.destroy();
  });

  it("空行削除で選択範囲内の空行が余らない", () => {
    const view = mk("a\n\n\nb", { anchor: 2, head: 4 }); // 2 つの空行(終端は b の行頭 = b の行は含めない)
    applyLineTransform(view, "remove_blank");
    expect(view.state.doc.toString()).toBe("a\nb");
    view.destroy();
    const v2 = mk("a\n\n \nb\n\n");
    applyLineTransform(v2, "remove_blank");
    expect(v2.state.doc.toString()).toBe("a\nb\n");
    v2.destroy();
  });

  it("重複削除と undo(1 回で戻る)", () => {
    const view = mk("a\nb\na\nb\n");
    applyLineTransform(view, "unique");
    expect(view.state.doc.toString()).toBe("a\nb\n");
    undo(view);
    expect(view.state.doc.toString()).toBe("a\nb\na\nb\n");
    view.destroy();
  });
});
