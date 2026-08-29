import { EditorSelection } from "@codemirror/state";
import { indentMore, indentLess } from "@codemirror/commands";

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

// --- 行単位の操作(見出しなど)。対象は選択範囲(複数可)にかかる行 ---

// 対象行を行番号順に返す(複数選択は合算、重複なし)
function selectedLines(state) {
  const seen = new Set();
  const lines = [];
  for (const r of state.selection.ranges) {
    const from = state.doc.lineAt(r.from).number;
    const to = state.doc.lineAt(r.to).number;
    for (let n = from; n <= to; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

// 複数行を対象にするときは空行を飛ばす(1 行だけなら空行でもマークを付けて書き始められるようにする)
function targetLines(state) {
  const lines = selectedLines(state);
  return lines.length > 1 ? lines.filter((l) => l.text.trim() !== "") : lines;
}

const HEADING_RE = /^(\s{0,3})(#{1,6})(?:\s+|$)/;

// 見出しレベルを level(1〜6)にする。0 で見出しを解除。既にそのレベルの行は変えない
export function setHeading(view, level) {
  const { state } = view;
  const prefix = level ? "#".repeat(level) + " " : "";
  const changes = [];
  for (const line of targetLines(state)) {
    const m = HEADING_RE.exec(line.text);
    if (m) {
      if (m[2].length === level) continue;
      changes.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert: prefix });
    } else if (level) {
      const indent = /^\s*/.exec(line.text)[0].length;
      changes.push({ from: line.from + indent, insert: prefix });
    }
  }
  if (!changes.length) return false;
  dispatchLineChanges(view, changes);
  return true;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])(?:\s+|$)/;
const CHECKBOX_RE = /^(\s*)([-*+]|\d+[.)])\s+\[( |x|X)\](?:\s+|$)/;

// チェックボックスを切り替える: [ ] ↔ [x]。リスト行にチェックボックスが無ければ [ ] を足し、
// リスト行でなければ "- [ ] " を付ける(複数行は各行を個別に反転)
export function toggleCheckbox(view) {
  const changes = [];
  for (const line of targetLines(view.state)) {
    const cb = CHECKBOX_RE.exec(line.text);
    if (cb) {
      const pos = line.from + cb[0].lastIndexOf("[") + 1;
      changes.push({ from: pos, to: pos + 1, insert: cb[3] === " " ? "x" : " " });
      continue;
    }
    const li = LIST_RE.exec(line.text);
    if (li) {
      const hasSpace = /\s$/.test(li[0]);
      changes.push({ from: line.from + li[0].length, insert: (hasSpace ? "" : " ") + "[ ] " });
    } else {
      const indent = /^\s*/.exec(line.text)[0].length;
      changes.push({ from: line.from + indent, insert: "- [ ] " });
    }
  }
  if (!changes.length) return false;
  dispatchLineChanges(view, changes);
  return true;
}

const MARKER_RES = {
  bullet: /^(\s*)[-*+](?:\s+|$)/,
  ordered: /^(\s*)\d+[.)](?:\s+|$)/,
  quote: /^(\s*)>\s?/,
};

// 箇条書き(bullet)/ 番号付きリスト(ordered)/ 引用(quote)の切替。
// 対象行がすべてそのマーク付きなら外し、そうでなければ足りない行に付ける。
// リストは他種のリストマークを置き換え、番号付きは対象行を 1 から連番にする。引用はリストマークの前に付く
export function toggleLineMarker(view, kind) {
  const { state } = view;
  const re = MARKER_RES[kind];
  const lines = targetLines(state);
  if (!lines.length) return false;
  const allHave = lines.every((l) => re.test(l.text));
  const changes = [];
  let n = 0;
  for (const line of lines) {
    const m = re.exec(line.text);
    if (allHave) {
      changes.push({ from: line.from + m[1].length, to: line.from + m[0].length });
      continue;
    }
    const marker = kind === "bullet" ? "- " : kind === "ordered" ? `${++n}. ` : "> ";
    if (m) {
      // 既に付いている行: 番号付きだけは連番に揃える
      if (kind === "ordered" && m[0] !== m[1] + marker) {
        changes.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert: marker });
      }
      continue;
    }
    const from = line.from + /^\s*/.exec(line.text)[0].length;
    let to = from;
    if (kind !== "quote") {
      const other = LIST_RE.exec(line.text);
      if (other) to = line.from + other[0].length;
    }
    changes.push({ from, to, insert: marker });
  }
  if (!changes.length) return false;
  dispatchLineChanges(view, changes);
  return true;
}

// リスト行で Tab / Shift+Tab: 項目をネスト / 解除する(インデント設定の単位で字下げ)。
// 選択範囲があるとき・カーソル行がリスト項目でないときは false を返して既定の Tab に任せる
function allCursorsOnListLines(state) {
  return state.selection.ranges.every((r) => r.empty && LIST_RE.test(state.doc.lineAt(r.head).text));
}

export function indentListItem(view) {
  return allCursorsOnListLines(view.state) ? indentMore(view) : false;
}

export function dedentListItem(view) {
  return allCursorsOnListLines(view.state) ? indentLess(view) : false;
}

// 行頭への挿入でカーソルがマークの前に取り残されないよう、選択は挿入の後ろ側へ写像する
function dispatchLineChanges(view, changes) {
  const set = view.state.changes(changes);
  view.dispatch({
    changes: set,
    selection: view.state.selection.map(set, 1),
    scrollIntoView: true,
    userEvent: "input",
  });
}

// メニュー項目 ID(md:<kind>[:<arg>])→ コマンド
export const MARKDOWN_COMMANDS = {
  bold: (view) => toggleInline(view, "**"),
  italic: (view) => toggleInline(view, "*"),
  strike: (view) => toggleInline(view, "~~"),
  code: (view) => toggleInline(view, "`"),
  link: insertLink,
  heading: (view, level) => setHeading(view, Number(level)),
  checkbox: toggleCheckbox,
  bullet: (view) => toggleLineMarker(view, "bullet"),
  ordered: (view) => toggleLineMarker(view, "ordered"),
  quote: (view) => toggleLineMarker(view, "quote"),
};
