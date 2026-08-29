import { describe, it, expect } from "vitest";
import { EditorSelection } from "@codemirror/state";
import {
  countChars,
  charCount,
  createEditorState,
  selectionCharCount,
  describeCharCount,
} from "./editor.js";

const state = (raw) => createEditorState(raw, () => {});
const edit = (s, spec) => s.update(spec).state;

describe("countChars", () => {
  it("改行を除いたコードポイント数を返す", () => {
    expect(countChars("")).toBe(0);
    expect(countChars("abc")).toBe(3);
    expect(countChars("あい\nう")).toBe(3);
    expect(countChars("a\r\nb\rc\n")).toBe(3);
  });

  it("サロゲートペアは 1 文字", () => {
    expect(countChars("🍣🍺")).toBe(2);
    expect(countChars("a🍣\nb")).toBe(3);
  });
});

describe("charCountField", () => {
  it("初期値は全文の文字数", () => {
    expect(charCount(state("abc\nあいう\n🍣"))).toBe(7);
  });

  it("挿入・削除・複数行にまたがる置換で差し引きした結果が全文の数え直しと一致する", () => {
    let s = state("abc\nあいう\n🍣");
    const check = () => expect(charCount(s)).toBe(countChars(s.doc.toString()));

    s = edit(s, { changes: { from: 3, insert: "🍺x\n" } });
    check();
    expect(charCount(s)).toBe(9);

    s = edit(s, { changes: { from: 0, to: 2 } }); // "ab" 削除
    check();

    s = edit(s, { changes: { from: 1, to: s.doc.length - 2, insert: "Z\n\nY" } }); // 末尾の絵文字の手前まで置換
    check();
    expect(charCount(s)).toBe(4); // "c" + "Z", "Y" + "🍣"
    check();

    s = edit(s, { changes: [{ from: 0, to: 1 }, { from: 2, insert: "\n" }] }); // 複数変更
    check();
  });

  it("本文が変わらないトランザクションでは値が変わらない", () => {
    const s = state("abc");
    const before = charCount(s);
    expect(charCount(edit(s, { selection: { anchor: 1 } }))).toBe(before);
  });
});

describe("selectionCharCount / describeCharCount", () => {
  it("選択が無ければ 0、複数選択は合計", () => {
    let s = state("あいう\n🍣えお");
    expect(selectionCharCount(s)).toBe(0);
    expect(describeCharCount(s)).toBe("6 文字");

    s = edit(s, { selection: { anchor: 0, head: 2 } });
    expect(selectionCharCount(s)).toBe(2);
    expect(describeCharCount(s)).toBe("選択 2 / 6 文字");

    // 改行と絵文字をまたぐ範囲 + もう 1 つの範囲
    s = edit(s, {
      selection: EditorSelection.create([
        EditorSelection.range(2, 6), // "う\n🍣"
        EditorSelection.range(7, 8), // "お"
      ]),
    });
    expect(selectionCharCount(s)).toBe(3);
  });

  it("千単位の区切りを付ける", () => {
    expect(describeCharCount(state("a".repeat(1234)))).toBe("1,234 文字");
  });
});
