import { EditorSelection } from "@codemirror/state";

// Markdown の書式ショートカット(編集 > Markdown): 選択範囲(複数可)をマーカーで囲む / 既に囲まれていれば外す。
// 選択が無ければマーカーの対を挿入してその間にカーソルを置く(対の間にカーソルがあれば対を消す)。
// どのファイルでも使える(Markdown 判定に依らない)

// s の先頭(または末尾)に ch が何個続くか(最大 3)
function run(s, ch, fromEnd) {
  let n = 0;
  while (n < 3 && n < s.length && s[fromEnd ? s.length - 1 - n : n] === ch) n++;
  return n;
}

// マーカーの連なりが「このマーカーで囲まれている」と言えるか。
// * の 1 つは斜体、2 つは太字、3 つは太字+斜体なので、斜体(1)は run 1 か 3、太字(2)は run 2 か 3 のときに囲まれている
function wrappedBy(runLen, marker) {
  return runLen === marker.length || (marker[0] === "*" && runLen === 3);
}

export function toggleInline(view, marker) {
  const { state } = view;
  const m = marker.length;
  const ch = marker[0];
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const doc = state.doc;
    const text = doc.sliceString(from, to);
    // 選択の内側ごと囲まれている(**text** を選んだ)→ 内側だけにする
    if (
      to - from >= 2 * m &&
      wrappedBy(run(text, ch, false), marker) &&
      wrappedBy(run(text, ch, true), marker)
    ) {
      const inner = text.slice(m, text.length - m);
      return {
        changes: { from, to, insert: inner },
        range: EditorSelection.range(from, from + inner.length),
      };
    }
    // 選択の外側が囲まれている(**[text]**、カーソルが対の間)→ 外す
    const before = run(doc.sliceString(Math.max(0, from - 3), from), ch, true);
    const after = run(doc.sliceString(to, to + 3), ch, false);
    if (wrappedBy(before, marker) && wrappedBy(after, marker)) {
      return {
        changes: [
          { from: from - m, to: from },
          { from: to, to: to + m },
        ],
        range: EditorSelection.range(from - m, to - m),
      };
    }
    if (from === to) {
      return { changes: { from, insert: marker + marker }, range: EditorSelection.cursor(from + m) };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: EditorSelection.range(from + m, to + m),
    };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  return true;
}

// リンク: 選択が URL なら [|](url)、テキストなら [text](|)、無ければ [|]()
export function insertLink(view) {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const { from, to } = range;
    const text = state.doc.sliceString(from, to);
    if (/^https?:\/\/\S+$/.test(text)) {
      return { changes: { from, to, insert: `[](${text})` }, range: EditorSelection.cursor(from + 1) };
    }
    const insert = `[${text}]()`;
    const cursor = text ? from + insert.length - 1 : from + 1;
    return { changes: { from, to, insert }, range: EditorSelection.cursor(cursor) };
  });
  view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
  return true;
}

// メニュー項目 ID(md:<kind>)→ コマンド
export const MARKDOWN_COMMANDS = {
  bold: (view) => toggleInline(view, "**"),
  italic: (view) => toggleInline(view, "*"),
  strike: (view) => toggleInline(view, "~~"),
  code: (view) => toggleInline(view, "`"),
  link: insertLink,
};
