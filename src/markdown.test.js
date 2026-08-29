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

describe("見出しレベル(setHeading)", () => {
  const mk = async (doc, sel) => {
    const { setHeading } = await import("./markdown.js");
    const { EditorSelection } = await import("@codemirror/state");
    const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
    if (sel) view.dispatch({ selection: sel });
    return { view, setHeading, EditorSelection };
  };

  it("行頭に # を付け、レベルを変え、0 で外す。同じレベルなら何もしない", async () => {
    const { view, setHeading } = await mk("title\nbody", { anchor: 2 });
    expect(setHeading(view, 2)).toBe(true);
    expect(view.state.doc.toString()).toBe("## title\nbody");
    expect(view.state.selection.main.head).toBe(5); // カーソルは同じ文字の上
    expect(setHeading(view, 2)).toBe(false);
    setHeading(view, 4);
    expect(view.state.doc.toString()).toBe("#### title\nbody");
    setHeading(view, 0);
    expect(view.state.doc.toString()).toBe("title\nbody");
    expect(setHeading(view, 0)).toBe(false);
    view.destroy();
  });

  it("# だけの行や先頭の空白(3 つまで)も見出しとして扱う", async () => {
    const { view, setHeading } = await mk("  ##\nx", { anchor: 0 });
    setHeading(view, 1);
    expect(view.state.doc.toString()).toBe("  # \nx");
    view.destroy();
  });

  it("複数行選択では各行に付け、空行は飛ばす。1 行だけなら空行にも付ける", async () => {
    const { view, setHeading } = await mk("a\n\n# b\nc", { anchor: 0, head: 7 });
    setHeading(view, 3);
    expect(view.state.doc.toString()).toBe("### a\n\n### b\n### c");
    view.destroy();
    const single = await mk("", { anchor: 0 });
    single.setHeading(single.view, 1);
    expect(single.view.state.doc.toString()).toBe("# ");
    expect(single.view.state.selection.main.head).toBe(2);
    single.view.destroy();
  });

  it("複数選択は合算して重複なく処理する", async () => {
    const { view, setHeading, EditorSelection } = await mk("a\nb\nc");
    view.dispatch({
      selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.range(2, 5)]),
    });
    setHeading(view, 1);
    expect(view.state.doc.toString()).toBe("# a\n# b\n# c");
    view.destroy();
  });
});

describe("チェックボックスの切替(toggleCheckbox)", () => {
  const mk = async (doc, sel) => {
    const { toggleCheckbox } = await import("./markdown.js");
    const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
    if (sel) view.dispatch({ selection: sel });
    return { view, toggleCheckbox };
  };

  it("[ ] と [x] を反転する(X も対象)", async () => {
    const { view, toggleCheckbox } = await mk("- [ ] a\n* [x] b\n1. [X] c\n  - [ ] d", { anchor: 0, head: 30 });
    expect(toggleCheckbox(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("- [x] a\n* [ ] b\n1. [ ] c\n  - [x] d");
    view.destroy();
  });

  it("チェックボックスの無いリスト行には [ ] を足し、リスト行でなければ - [ ] を付ける", async () => {
    const { view, toggleCheckbox } = await mk("- a\n2) b\nplain\n  indented", { anchor: 0, head: 25 });
    toggleCheckbox(view);
    expect(view.state.doc.toString()).toBe("- [ ] a\n2) [ ] b\n- [ ] plain\n  - [ ] indented");
    view.destroy();
  });

  it("空行 1 行なら - [ ] を付けてカーソルをその後ろに置く。マーカーだけの行にも付く", async () => {
    const { view, toggleCheckbox } = await mk("", { anchor: 0 });
    toggleCheckbox(view);
    expect(view.state.doc.toString()).toBe("- [ ] ");
    expect(view.state.selection.main.head).toBe(6);
    view.destroy();
    const m = await mk("-", { anchor: 1 });
    m.toggleCheckbox(m.view);
    expect(m.view.state.doc.toString()).toBe("- [ ] ");
    m.view.destroy();
  });
});

describe("URL の貼り付けでリンク化(pasteURLAsLink)", () => {
  const paste = (view, text) => {
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = { getData: () => text };
    view.contentDOM.dispatchEvent(ev);
    return ev.defaultPrevented;
  };

  it("テキストを選んで URL を貼ると [テキスト](URL) になる(www. は https:// を補う)", async () => {
    const view = await markdownView("see docs here");
    view.dispatch({ selection: { anchor: 4, head: 8 } });
    expect(paste(view, "https://x.test/p")).toBe(true);
    expect(view.state.doc.toString()).toBe("see [docs](https://x.test/p) here");
    view.dispatch({ selection: { anchor: 29, head: 33 } });
    paste(view, "www.x.test");
    expect(view.state.doc.toString()).toBe("see [docs](https://x.test/p) [here](https://www.x.test)");
    view.destroy();
  });

  it("選択が無い・URL でない・Markdown 以外のタブでは通常の貼り付けになる", async () => {
    // CodeMirror 自身が paste を処理する(preventDefault する)ので、本文の結果で判定する
    const view = await markdownView("abc");
    view.dispatch({ selection: { anchor: 1 } });
    paste(view, "https://x.test/");
    expect(view.state.doc.toString()).toBe("ahttps://x.test/bc");
    view.dispatch({ selection: { anchor: 0, head: 1 } });
    paste(view, "plain text");
    expect(view.state.doc.toString()).toBe("plain texthttps://x.test/bc");
    view.destroy();
    const plain = new EditorView({ state: createEditorState("abc", () => {}), parent: document.body });
    plain.dispatch({ selection: { anchor: 0, head: 3 } });
    paste(plain, "https://x.test/");
    expect(plain.state.doc.toString()).toBe("https://x.test/");
    plain.destroy();
  });
});

describe("リスト行の Tab / Shift+Tab(ネスト / 解除)", () => {
  it("カーソル行がリスト項目なら字下げし、Shift+Tab で戻す。リスト行以外は従来どおりタブ文字", async () => {
    const view = await markdownView("- a\n- b\ntext");
    view.dispatch({ selection: { anchor: 6 } }); // "- b" の途中
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("- a\n\t- b\ntext");
    key(view, "Tab", { shiftKey: true });
    expect(view.state.doc.toString()).toBe("- a\n- b\ntext");
    view.dispatch({ selection: { anchor: 12 } }); // "text" の末尾
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("- a\n- b\ntext\t");
    view.destroy();
  });

  it("番号付き・チェックボックス付きの行も対象。選択範囲があれば既定の動作(行インデント)", async () => {
    const view = await markdownView("1. a\n- [ ] b");
    view.dispatch({ selection: { anchor: 0 } });
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("\t1. a\n- [ ] b");
    view.dispatch({ selection: { anchor: 6, head: 9 } });
    key(view, "Tab");
    expect(view.state.doc.toString()).toBe("\t1. a\n\t- [ ] b");
    view.destroy();
  });
});

describe("箇条書き / 番号付き / 引用の切替(toggleLineMarker)", () => {
  const mk = async (doc, sel) => {
    const { toggleLineMarker } = await import("./markdown.js");
    const view = new EditorView({ state: createEditorState(doc, () => {}), parent: document.body });
    if (sel) view.dispatch({ selection: sel });
    return { view, t: (kind) => toggleLineMarker(view, kind), doc: () => view.state.doc.toString() };
  };

  it("箇条書き: 付ける → 全行に付いていれば外す。空行は飛ばし、番号付きは置き換える", async () => {
    const { view, t, doc } = await mk("a\n\n1. b\n  c", { anchor: 0, head: 11 });
    t("bullet");
    expect(doc()).toBe("- a\n\n- b\n  - c");
    t("bullet");
    expect(doc()).toBe("a\n\nb\n  c");
    view.destroy();
  });

  it("一部の行だけマーク付きなら足りない行に付ける(外さない)", async () => {
    const { view, t, doc } = await mk("- a\nb", { anchor: 0, head: 5 });
    t("bullet");
    expect(doc()).toBe("- a\n- b");
    view.destroy();
  });

  it("番号付き: 1 から連番にし、既存の番号も揃える。全行番号付きなら外す", async () => {
    const { view, t, doc } = await mk("a\n5. b\n- c", { anchor: 0, head: 10 });
    t("ordered");
    expect(doc()).toBe("1. a\n2. b\n3. c");
    t("ordered");
    expect(doc()).toBe("a\nb\nc");
    view.destroy();
  });

  it("引用: リストマークの前に付き、外すときは > だけ外す", async () => {
    const { view, t, doc } = await mk("- a\ntext", { anchor: 0, head: 8 });
    t("quote");
    expect(doc()).toBe("> - a\n> text");
    t("quote");
    expect(doc()).toBe("- a\ntext");
    view.destroy();
  });

  it("1 行(空行)でも付けてカーソルをマークの後ろに置く", async () => {
    const { view, t, doc } = await mk("", { anchor: 0 });
    t("ordered");
    expect(doc()).toBe("1. ");
    expect(view.state.selection.main.head).toBe(3);
    view.destroy();
  });
});
