import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { createEditorState, languageEffect, markdownExtras } from "./editor.js";

const key = (view, k, opts = {}) =>
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

async function markdownView(doc) {
  const support = await LanguageDescription.matchFilename(languages, "a.md").load();
  const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
  view.dispatch({ effects: languageEffect(support, markdownExtras) });
  return view;
}

describe("Markdown 入力支援", () => {
  it("Enter でリスト項目を継続し、空の項目で Enter すると空行を挟み、もう一度で項目を終える", async () => {
    const view = await markdownView("- item");
    view.dispatch({ selection: { anchor: 6 } });
    key(view, "Enter");
    expect(view.state.doc.toString()).toBe("- item\n- ");
    key(view, "Enter"); // 2 つ目の項目が空: 空行を挟んで loose list にする(CodeMirror の仕様)
    expect(view.state.doc.toString()).toBe("- item\n\n- ");
    key(view, "Enter"); // 空行の後の空項目: マークアップを消して終える
    expect(view.state.doc.toString()).toBe("- item\n\n");
    view.destroy();
  });

  it("3 つ目以降の空の項目は Enter でそのまま終える", async () => {
    const view = await markdownView("- a\n- b\n- ");
    view.dispatch({ selection: { anchor: 10 } });
    key(view, "Enter");
    expect(view.state.doc.toString()).toBe("- a\n- b\n");
    view.destroy();
  });

  it("番号付きリスト・引用・チェックボックスも継続する", async () => {
    for (const [doc, expected] of [
      ["1. a", "1. a\n2. "],
      ["> quote", "> quote\n> "],
      ["- [x] done", "- [x] done\n- [ ] "],
    ]) {
      const view = await markdownView(doc);
      view.dispatch({ selection: { anchor: doc.length } });
      key(view, "Enter");
      expect(view.state.doc.toString()).toBe(expected);
      view.destroy();
    }
  });

  it("Backspace で行頭のマークアップを消す", async () => {
    const view = await markdownView("- ");
    view.dispatch({ selection: { anchor: 2 } });
    key(view, "Backspace");
    expect(view.state.doc.toString()).toBe("");
    view.destroy();
  });

  it("Markdown 以外のタブ(extras なし)では通常の改行", async () => {
    const view = new EditorView({ state: createEditorState("- item", () => {}), parent: document.body });
    view.dispatch({ selection: { anchor: 6 } });
    key(view, "Enter");
    expect(view.state.doc.toString()).toBe("- item\n");
    view.destroy();
  });
});
