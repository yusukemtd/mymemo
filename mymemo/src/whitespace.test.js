import { describe, it, expect } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  createEditorState,
  eolDecorations,
  eolField,
  setAllLineEndings,
  setShowWhitespace,
  EOL_GLYPHS,
} from "./editor.js";

// RangeSet を [{pos, lineEnding}] に展開する
function collect(set) {
  const out = [];
  for (const it = set.iter(); it.value; it.next()) {
    out.push({ pos: it.from, lineEnding: it.value.spec.widget.lineEnding });
  }
  return out;
}
const markersOf = (raw) => createEditorState(raw, () => {}).field(eolField).set;

describe("eolDecorations", () => {
  const set = markersOf("ab\r\ncd\ref"); // 末尾改行なし
  const whole = [{ from: 0, to: 7 }];

  it("各行末にその行の改行コードの記号を置き、後ろに改行のない最終行には置かない", () => {
    expect(collect(eolDecorations(set, whole))).toEqual([
      { pos: 2, lineEnding: "CRLF" },
      { pos: 5, lineEnding: "CR" },
    ]);
  });

  it("末尾改行があれば最後の空行の手前まで記号が付く", () => {
    expect(collect(eolDecorations(markersOf("ab\n"), [{ from: 0, to: 3 }]))).toEqual([
      { pos: 2, lineEnding: "LF" },
    ]);
  });

  it("空ドキュメントには何も付かない", () => {
    expect(collect(eolDecorations(markersOf(""), [{ from: 0, to: 0 }]))).toEqual([]);
  });

  it("表示範囲に含まれる行だけを対象にする", () => {
    expect(collect(eolDecorations(set, [{ from: 3, to: 4 }]))).toEqual([]);
    expect(collect(eolDecorations(set, [{ from: 3, to: 5 }]))).toEqual([
      { pos: 5, lineEnding: "CR" },
    ]);
  });

  it("範囲が行末ちょうどで区切られても同じ行に二重に付かない", () => {
    const ranges = [
      { from: 0, to: 2 },
      { from: 2, to: 7 },
    ];
    expect(collect(eolDecorations(set, ranges)).map((r) => r.pos)).toEqual([2, 5]);
  });
});

describe("エディタ上の空白文字・改行の可視化", () => {
  const makeView = (raw) =>
    new EditorView({
      state: createEditorState(raw, () => {}),
      parent: document.body,
    });
  const query = (view, cls) => view.contentDOM.querySelectorAll("." + cls);
  const eolTexts = (view) => [...query(view, "mm-ws-eol")].map((e) => e.textContent);

  it("種類ごとに別クラスのマークが 1 文字ずつ付く", () => {
    const view = makeView("a  b\tc\u3000d\u00a0e"); // 全角スペース・NBSP はエスケープで明示
    expect(query(view, "mm-ws-space")).toHaveLength(2);
    expect(query(view, "mm-ws-tab")).toHaveLength(1);
    expect(query(view, "mm-ws-ideo")).toHaveLength(1);
    expect(query(view, "mm-ws-nbsp")).toHaveLength(1);
    expect(query(view, "mm-ws-nbsp")[0].textContent).toBe("\u00a0");
    view.destroy();
  });

  it("行末記号は行ごとの改行コードに応じた文字になる", () => {
    const view = makeView("a\r\nb\rc\nd");
    const eols = [...query(view, "mm-ws-eol")];
    expect(eols.map((e) => e.textContent)).toEqual([
      EOL_GLYPHS.CRLF,
      EOL_GLYPHS.CR,
      EOL_GLYPHS.LF,
    ]);
    expect(eols.map((e) => e.title)).toEqual(["CRLF", "CR", "LF"]);
    view.destroy();
  });

  it("改行コードを統一すると行末記号も追従する", () => {
    const view = makeView("a\r\nb\rc");
    view.dispatch({ effects: setAllLineEndings.of("LF") });
    expect(eolTexts(view)).toEqual([EOL_GLYPHS.LF, EOL_GLYPHS.LF]);
    view.destroy();
  });

  it("Enter で増えた行にも記号が付く", () => {
    const view = makeView("a\r\nb");
    view.dispatch({ changes: { from: 1, insert: "\n" } });
    expect(eolTexts(view)).toEqual([EOL_GLYPHS.CRLF, EOL_GLYPHS.CRLF]);
    view.destroy();
  });

  it("表示をオフにすると装飾が消え、オンで戻る", () => {
    const view = makeView("a b\nc");
    view.dispatch({ effects: setShowWhitespace(false)() });
    expect(query(view, "mm-ws-space")).toHaveLength(0);
    expect(query(view, "mm-ws-eol")).toHaveLength(0);
    view.dispatch({ effects: setShowWhitespace(true)() });
    expect(query(view, "mm-ws-space")).toHaveLength(1);
    expect(query(view, "mm-ws-eol")).toHaveLength(1);
    view.destroy();
  });

  it("setShowWhitespace(false) 後に作る state は装飾なしで始まる", () => {
    setShowWhitespace(false);
    const view = makeView("a b\nc");
    expect(query(view, "mm-ws-space")).toHaveLength(0);
    view.destroy();
    setShowWhitespace(true);
  });

  it("編集後も装飾が更新される", () => {
    const view = makeView("ab");
    view.dispatch({ changes: { from: 1, insert: " \n" } });
    expect(query(view, "mm-ws-space")).toHaveLength(1);
    expect(query(view, "mm-ws-eol")).toHaveLength(1);
    view.destroy();
  });
});
