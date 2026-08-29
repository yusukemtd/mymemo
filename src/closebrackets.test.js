import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { insertBracket } from "@codemirror/autocomplete";
import { createEditorState, setCloseBrackets } from "./editor.js";

const key = (view, k) =>
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
// 入力時の補完は EditorView.inputHandler として登録される(closeBrackets 拡張が入っているときだけ)
const handlers = (view) => view.state.facet(EditorView.inputHandler).length;

describe("括弧・引用符の自動補完", () => {
  it("OFF(既定)では入力ハンドラが無く Backspace は 1 文字だけ消す", () => {
    setCloseBrackets(false);
    const view = new EditorView({ state: createEditorState("()", () => {}), parent: document.body });
    expect(handlers(view)).toBe(0);
    view.dispatch({ selection: { anchor: 1 } });
    key(view, "Backspace");
    expect(view.state.doc.toString()).toBe(")");
    view.destroy();
  });

  it("ON にすると入力ハンドラが入り、閉じ記号を補って Backspace で対ごと消える。新規 state にも効く", () => {
    setCloseBrackets(false);
    const view = new EditorView({ state: createEditorState("", () => {}), parent: document.body });
    view.dispatch({ effects: setCloseBrackets(true)() });
    expect(handlers(view)).toBe(1);
    view.dispatch(insertBracket(view.state, "(")); // 入力ハンドラが呼ぶのと同じ処理
    expect(view.state.doc.toString()).toBe("()");
    expect(view.state.selection.main.head).toBe(1);
    key(view, "Backspace");
    expect(view.state.doc.toString()).toBe("");

    const view2 = new EditorView({ state: createEditorState("", () => {}), parent: document.body });
    expect(handlers(view2)).toBe(1);
    setCloseBrackets(false);
    view.destroy();
    view2.destroy();
  });
});
