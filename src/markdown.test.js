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

describe("書式ショートカット(toggleInline / insertLink)", () => {
  const mk = async (doc, sel) => {
    const { toggleInline, insertLink, MARKDOWN_COMMANDS } = await import("./markdown.js");
    const { EditorSelection } = await import("@codemirror/state");
    const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
    if (sel) view.dispatch({ selection: sel });
    const sel2 = () => [view.state.selection.main.from, view.state.selection.main.to];
    return { view, toggleInline, insertLink, MARKDOWN_COMMANDS, EditorSelection, sel2 };
  };

  it("選択範囲を囲み、もう一度で外す(選択は内側のテキストを保つ)", async () => {
    const { view, toggleInline, sel2 } = await mk("say hello", { anchor: 4, head: 9 });
    toggleInline(view, "**");
    expect(view.state.doc.toString()).toBe("say **hello**");
    expect(sel2()).toEqual([6, 11]);
    toggleInline(view, "**");
    expect(view.state.doc.toString()).toBe("say hello");
    expect(sel2()).toEqual([4, 9]);
    view.destroy();
  });

  it("マーカーごと選んでいても外せる", async () => {
    const { view, toggleInline, sel2 } = await mk("a ~~x~~ b", { anchor: 2, head: 7 });
    toggleInline(view, "~~");
    expect(view.state.doc.toString()).toBe("a x b");
    expect(sel2()).toEqual([2, 3]);
    view.destroy();
  });

  it("選択が無ければ対を挿入してカーソルを間に置き、対の間でもう一度押すと消す", async () => {
    const { view, toggleInline, sel2 } = await mk("ab", { anchor: 1 });
    toggleInline(view, "`");
    expect(view.state.doc.toString()).toBe("a``b");
    expect(sel2()).toEqual([2, 2]);
    toggleInline(view, "`");
    expect(view.state.doc.toString()).toBe("ab");
    expect(sel2()).toEqual([1, 1]);
    view.destroy();
  });

  it("太字と斜体を重ねられ、それぞれ独立に外せる", async () => {
    const { view, toggleInline } = await mk("**bold**", { anchor: 2, head: 6 });
    toggleInline(view, "*"); // 太字の中で斜体 → ***bold***
    expect(view.state.doc.toString()).toBe("***bold***");
    toggleInline(view, "**"); // 太字を外す → *bold*
    expect(view.state.doc.toString()).toBe("*bold*");
    toggleInline(view, "*");
    expect(view.state.doc.toString()).toBe("bold");
    view.destroy();
  });

  it("複数選択の各範囲に効く", async () => {
    const { view, toggleInline, EditorSelection } = await mk("a b c");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 1), EditorSelection.range(4, 5)]),
    });
    toggleInline(view, "**");
    expect(view.state.doc.toString()).toBe("**a** b **c**");
    view.destroy();
  });

  it("リンク: URL 選択 / テキスト選択 / 選択なし", async () => {
    const a = await mk("see https://x.test/p", { anchor: 4, head: 20 });
    a.insertLink(a.view);
    expect(a.view.state.doc.toString()).toBe("see [](https://x.test/p)");
    expect(a.sel2()).toEqual([5, 5]);
    a.view.destroy();
    const b = await mk("see docs", { anchor: 4, head: 8 });
    b.insertLink(b.view);
    expect(b.view.state.doc.toString()).toBe("see [docs]()");
    expect(b.sel2()).toEqual([11, 11]);
    b.view.destroy();
    const c = await mk("", { anchor: 0 });
    c.MARKDOWN_COMMANDS.link(c.view);
    expect(c.view.state.doc.toString()).toBe("[]()");
    expect(c.sel2()).toEqual([1, 1]);
    c.view.destroy();
  });
});
