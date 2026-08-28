import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { undo, redo } from "@codemirror/commands";
import {
  createEditorState,
  parseDocument,
  docWithLineEndings,
  lineEndingSummary,
  describeLineEndings,
  setAllLineEndings,
  eolField,
} from "./editor.js";

const make = (raw) => createEditorState(raw, () => {});
const apply = (state, spec) => state.update(spec).state;
const markerPositions = (state) => {
  const out = [];
  for (const it = state.field(eolField).set.iter(); it.value; it.next()) {
    out.push([it.from, it.value.eol]);
  }
  return out;
};
// 不変条件: 改行マーカーは行末(最終行以外)に 1 つずつ、counts はその集計と一致
function checkInvariants(state) {
  const doc = state.doc;
  const markers = markerPositions(state);
  const expected = [];
  for (let i = 1; i < doc.lines; i++) expected.push(doc.line(i).to);
  expect(markers.map(([p]) => p)).toEqual(expected);
  const tally = { LF: 0, CRLF: 0, CR: 0 };
  for (const [, eol] of markers) tally[eol]++;
  expect(state.field(eolField).counts).toEqual(tally);
}
// undo/redo コマンドは view 相当の {state, dispatch} で動かす
function withHistory(state) {
  const target = {
    get state() {
      return state;
    },
    dispatch(tr) {
      state = tr.state;
    },
  };
  return { target, current: () => state };
}

describe("parseDocument", () => {
  it("改行コードごとに行を分け、行末位置にマーカーを置く", () => {
    const { doc, eol } = parseDocument("a\r\nbb\rc\nd");
    expect([...doc.iterLines()]).toEqual(["a", "bb", "c", "d"]);
    const pos = [];
    for (const it = eol.set.iter(); it.value; it.next()) pos.push([it.from, it.value.eol]);
    expect(pos).toEqual([
      [1, "CRLF"],
      [4, "CR"],
      [6, "LF"],
    ]);
    expect(eol.counts).toEqual({ LF: 1, CRLF: 1, CR: 1 });
  });

  it("改行なし・空文字列", () => {
    expect(parseDocument("").doc.lines).toBe(1);
    expect(parseDocument("abc").eol.counts).toEqual({ LF: 0, CRLF: 0, CR: 0 });
  });
});

describe("docWithLineEndings", () => {
  it.each(["", "abc", "a\nb", "a\r\nb\r\n", "a\rb\rc", "a\r\nb\rc\nd\n\n", "\r\n\r\n", "\n\r\n\r"])(
    "往復で元のテキストに戻る: %j",
    (raw) => {
      const state = make(raw);
      checkInvariants(state);
      expect(docWithLineEndings(state)).toBe(raw);
    }
  );

  it("override を渡すと全行その改行コードになる", () => {
    expect(docWithLineEndings(make("a\r\nb\rc\n"), "LF")).toBe("a\nb\nc\n");
  });

  it("eolField なしで作った state でも LF として動く", () => {
    const state = EditorState.create({ doc: "a\nb", extensions: [eolField] });
    expect(docWithLineEndings(state)).toBe("a\nb");
  });
});

describe("編集への追従", () => {
  it("行末での Enter はその行の改行コードを引き継ぐ", () => {
    let s = make("a\r\nb\nc");
    s = apply(s, { changes: { from: 1, insert: "\n" } }); // "a" の行末
    expect(docWithLineEndings(s)).toBe("a\r\n\r\nb\nc");
    s = apply(s, { changes: { from: s.doc.length, insert: "\nd" } }); // 最終行 → 直前の行(LF)
    expect(docWithLineEndings(s)).toBe("a\r\n\r\nb\nc\nd");
    checkInvariants(s);
  });

  it("行の途中での Enter もその行の改行コードになる", () => {
    const s = apply(make("abc\rdef\r"), { changes: { from: 1, insert: "\n" } });
    expect(docWithLineEndings(s)).toBe("a\rbc\rdef\r");
  });

  it("改行が 1 つもないときは fallback(LF)", () => {
    const s = apply(make("abc"), { changes: { from: 3, insert: "\n" } });
    expect(docWithLineEndings(s)).toBe("abc\n");
  });

  it("行の結合でマーカーが消える", () => {
    const s = apply(make("a\r\nb\nc"), { changes: { from: 1, to: 2 } });
    expect(docWithLineEndings(s)).toBe("ab\nc");
    expect(s.field(eolField).counts).toEqual({ LF: 1, CRLF: 0, CR: 0 });
    checkInvariants(s);
  });

  it("行末に文字を打ってもマーカーは行末に留まる", () => {
    let s = make("a\r\nb\rc");
    s = apply(s, { changes: { from: 1, insert: "xyz" } });
    expect(docWithLineEndings(s)).toBe("axyz\r\nb\rc");
    s = apply(s, { changes: { from: 0, insert: "\n" } }); // 先頭で Enter → 1 行目(CRLF)
    expect(docWithLineEndings(s)).toBe("\r\naxyz\r\nb\rc");
    checkInvariants(s);
  });

  it("複数行にまたがる置換は消えた改行の改行コードを順に引き継ぐ", () => {
    const s = apply(make("a\r\nb\rc\nd"), {
      changes: { from: 0, to: 7, insert: "x\ny\nz\nw" },
    });
    expect(docWithLineEndings(s)).toBe("x\r\ny\rz\nw");
    checkInvariants(s);
  });

  it("引き継げる改行より多く挿入した分は挿入先の行の改行コード", () => {
    const s = apply(make("a\rb\nc"), { changes: { from: 0, to: 2, insert: "1\n2\n3\n" } });
    expect(docWithLineEndings(s)).toBe("1\r2\r3\rb\nc");
  });

  it("複数カーソルでの同時挿入", () => {
    const s = apply(make("a\r\nb\nc"), {
      changes: [
        { from: 1, insert: "\n" },
        { from: 4, insert: "\n" },
      ],
    });
    expect(docWithLineEndings(s)).toBe("a\r\n\r\nb\n\nc");
    checkInvariants(s);
  });

  it("undo で消した改行が元の改行コードで戻り、redo で再び消える", () => {
    const { target, current } = withHistory(make("a\rb\r\nc\n"));
    target.dispatch(current().update({ changes: { from: 1, to: 2 } })); // "a"+"b" を結合(CR が消える)
    expect(docWithLineEndings(current())).toBe("ab\r\nc\n");
    expect(undo(target)).toBe(true);
    expect(docWithLineEndings(current())).toBe("a\rb\r\nc\n");
    checkInvariants(current());
    expect(redo(target)).toBe(true);
    expect(docWithLineEndings(current())).toBe("ab\r\nc\n");
    checkInvariants(current());
  });

  it("undo の復元は途中に別の編集があっても位置を追従する", () => {
    const { target, current } = withHistory(make("a\rb\n"));
    target.dispatch(current().update({ changes: { from: 1, to: 2 } })); // "ab\n"
    target.dispatch(current().update({ changes: { from: 0, insert: "XX" }, userEvent: "input" })); // "XXab\n"
    undo(target); // "ab\n"
    undo(target); // "a\rb\n"
    expect(docWithLineEndings(current())).toBe("a\rb\n");
    checkInvariants(current());
  });

  it("setAllLineEndings で全行統一し、以後の Enter もその改行コードになる", () => {
    let s = apply(make("a\r\nb\rc"), { effects: setAllLineEndings.of("LF") });
    expect(docWithLineEndings(s)).toBe("a\nb\nc");
    s = apply(make("abc"), { effects: setAllLineEndings.of("CRLF") }); // 改行なし → fallback 更新
    s = apply(s, { changes: { from: 3, insert: "\n" } });
    expect(docWithLineEndings(s)).toBe("abc\r\n");
    checkInvariants(s);
  });

  it("CR 改行の直後の空行が LF 改行なら、保存結果は CRLF 1 行として読み直される", () => {
    // "a\r" + "" + "\n" + "c" のバイト列は "a\r\nc" にしかならない(形式上の制約)
    const s = apply(make("a\rb\nc"), { changes: { from: 2, to: 3 } }); // "b" を消して空行にする
    expect(s.doc.lines).toBe(3);
    expect(docWithLineEndings(s)).toBe("a\r\nc");
    expect(make(docWithLineEndings(s)).doc.lines).toBe(2);
  });

  it("ランダム編集でも不変条件が保たれ、保存結果が安定する", () => {
    let seed = 12345;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const pieces = ["a", "\n", "\n\n", "xy", "\nz\n", ""];
    const { target, current } = withHistory(make("l1\r\nl2\rl3\nl4"));
    for (let i = 0; i < 300; i++) {
      const s = current();
      const len = s.doc.length;
      const from = rnd(len + 1);
      const to = Math.min(len, from + rnd(4));
      const op = rnd(10);
      if (op < 7) {
        target.dispatch(s.update({ changes: { from, to, insert: pieces[rnd(pieces.length)] } }));
      } else if (op < 9) {
        undo(target);
      } else {
        redo(target);
      }
      checkInvariants(current());
      // 保存 → 再読込 → 再保存でバイト列が安定する。
      // (「CR 改行 + 空行 + LF 改行」は \r\n = CRLF と区別できないため、行構造まで同一とは限らない)
      const saved = docWithLineEndings(current());
      expect(docWithLineEndings(make(saved))).toBe(saved);
    }
  });
});

describe("lineEndingSummary / describeLineEndings", () => {
  it("単一の改行コードはそのまま", () => {
    expect(lineEndingSummary(make("a\r\nb\r\n"))).toEqual({
      counts: { LF: 0, CRLF: 2, CR: 0 },
      dominant: "CRLF",
      mixed: false,
    });
    expect(describeLineEndings(make("a\nb"))).toBe("LF");
  });

  it("改行なしは fallback の LF", () => {
    expect(describeLineEndings(make("abc"))).toBe("LF");
    expect(describeLineEndings(make(""))).toBe("LF");
  });

  it("混在は多い順の内訳付き", () => {
    const s = make("a\r\nb\r\nc\nd\re\r\n");
    expect(lineEndingSummary(s).dominant).toBe("CRLF");
    expect(lineEndingSummary(s).mixed).toBe(true);
    expect(describeLineEndings(s)).toBe("混在 (CRLF 3, LF 1, CR 1)");
  });
});
