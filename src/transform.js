// テキスト変換(編集 > テキスト変換): 行単位の操作。
// 選択範囲があればその範囲にかかる行、無ければ全行が対象。1 回の変更として適用するので undo は 1 回で戻る

// 文字列の比較はコードポイント順(ロケール非依存で結果が予測しやすい)
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const LINE_TRANSFORMS = {
  sort_asc: { label: "行を昇順にソート", run: (lines) => [...lines].sort(compare) },
  sort_desc: { label: "行を降順にソート", run: (lines) => [...lines].sort((a, b) => compare(b, a)) },
  unique: {
    label: "重複する行を削除",
    run: (lines) => {
      const seen = new Set();
      return lines.filter((l) => !seen.has(l) && seen.add(l));
    },
  },
  remove_blank: { label: "空行を削除", run: (lines) => lines.filter((l) => l.trim() !== "") },
};

export function transformLines(lines, kind) {
  const t = LINE_TRANSFORMS[kind];
  if (!t) throw new Error(`未知の変換: ${kind}`);
  return t.run(lines);
}

// 対象範囲 { from, to }。選択が無ければ全文。選択があれば先頭行の行頭から末尾行の行末まで
// (選択の終端が行頭にあるときはその行を含めない)。範囲の直後に改行があればそれも含める
// (行を減らす変換で改行が余らないようにするため。呼び出し側は末尾の改行を切り離して扱う)
export function lineRangeForSelection(state) {
  const sel = state.selection.main;
  const doc = state.doc;
  if (sel.empty) return { from: 0, to: doc.length };
  const startLine = doc.lineAt(sel.from);
  let endLine = doc.lineAt(sel.to);
  if (sel.to === endLine.from && endLine.number > startLine.number) {
    endLine = doc.line(endLine.number - 1);
  }
  const to = endLine.to < doc.length ? endLine.to + 1 : endLine.to;
  return { from: startLine.from, to };
}

// 変換を適用する。変化が無ければ false
export function applyLineTransform(view, kind) {
  const { state } = view;
  const { from, to } = lineRangeForSelection(state);
  let text = state.doc.sliceString(from, to);
  const trailing = text.endsWith("\n"); // 範囲末尾の改行(全文なら終端改行)は並べ替えの対象にしない
  if (trailing) text = text.slice(0, -1);
  const out = transformLines(text.split("\n"), kind);
  const body = out.join("\n");
  const insert = body + (trailing && out.length ? "\n" : "");
  if (insert === text + (trailing ? "\n" : "")) return false;
  const spec = { changes: { from, to, insert } };
  if (!state.selection.main.empty) spec.selection = { anchor: from, head: from + body.length };
  view.dispatch(spec);
  return true;
}
