import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { foldCode, unfoldCode, foldedRanges, foldable, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { createEditorState, languageEffect, setFoldGutter } from "./editor.js";

async function jsView(doc) {
  const support = await LanguageDescription.matchFilename(languages, "a.js").load();
  const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
  view.dispatch({ effects: languageEffect(support) });
  return view;
}

const folded = (state) => {
  const out = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => out.push([from, to]));
  return out;
};

describe("コード折りたたみ", () => {
  it("言語が判定できたファイルでは関数本体を折りたたんで展開できる", async () => {
    const view = await jsView("function f() {\n  return 1;\n}\n");
    const line1 = view.state.doc.line(1);
    expect(foldable(view.state, line1.from, line1.to)).toEqual({ from: 14, to: 27 });
    view.dispatch({ selection: { anchor: 0 } });
    expect(foldCode(view)).toBe(true);
    expect(folded(view.state)).toEqual([[14, 27]]);
    expect(unfoldCode(view)).toBe(true);
    expect(folded(view.state)).toEqual([]);
    view.destroy();
  });

  it("プレーンテキストでは折りたためない", () => {
    const view = new EditorView({ state: createEditorState("a {\n b\n}\n", () => {}), parent: document.body });
    expect(foldCode(view)).toBe(false);
    view.destroy();
  });

  it("ガターの表示は setFoldGutter で切り替わり、新規 state にも効く", () => {
    setFoldGutter(true);
    const view = new EditorView({ state: createEditorState("a", () => {}), parent: document.body });
    expect(view.dom.querySelector(".cm-foldGutter")).not.toBeNull();
    view.dispatch({ effects: setFoldGutter(false)() });
    expect(view.dom.querySelector(".cm-foldGutter")).toBeNull();
    const view2 = new EditorView({ state: createEditorState("a", () => {}), parent: document.body });
    expect(view2.dom.querySelector(".cm-foldGutter")).toBeNull();
    setFoldGutter(true);
    view.destroy();
    view2.destroy();
  });
});
