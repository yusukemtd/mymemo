import { getSearchQuery } from "@codemirror/search";

// 検索パネルの補助: 一致件数の集計と「選択範囲内を置換」。
// 置換文字列の展開は @codemirror/search の内部実装(公開 API に無い)と同じ規則で行う

export const COUNT_LIMIT = 10000;

// 置換文字列を展開する: literal でなければ \n \r \t \\ を解釈し、正規表現なら $1 / $& / $$ を展開する
export function expandReplacement(query, result) {
  const unquoted = query.literal
    ? query.replace
    : query.replace.replace(/\\([nrt\\])/g, (_, ch) =>
        ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : "\\"
      );
  if (!query.regexp) return unquoted;
  return unquoted.replace(/\$([$&]|\d+)/g, (m, i) => {
    if (i === "&") return result.match[0];
    if (i === "$") return "$";
    for (let l = i.length; l > 0; l--) {
      const n = +i.slice(0, l);
      if (n > 0 && n < result.match.length) return result.match[n] + i.slice(l);
    }
    return m;
  });
}

// 全文の一致範囲(limit 件で打ち切り)。検索語が空・正規表現が不正なら空
export function countMatches(state, query, limit = COUNT_LIMIT) {
  if (!query.valid) return { ranges: [], truncated: false };
  const ranges = [];
  const cursor = query.getCursor(state);
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    if (ranges.length >= limit) return { ranges, truncated: true };
    ranges.push({ from: m.value.from, to: m.value.to });
  }
  return { ranges, truncated: false };
}

// 選択範囲がどれかの一致と一致していればその 1 始まりの番号、なければ 0
export function currentMatchIndex(ranges, sel) {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].from < sel.from) lo = mid + 1;
    else hi = mid;
  }
  const r = ranges[lo];
  return r && r.from === sel.from && r.to === sel.to ? lo + 1 : 0;
}

// 件数表示: "3 / 12 件" / "12 件" / "10,000+ 件"。検索語が無ければ空文字
export function describeMatches(query, { ranges, truncated }, sel) {
  if (!query.search) return "";
  const total = ranges.length.toLocaleString("ja-JP") + (truncated ? "+" : "");
  const index = truncated ? 0 : currentMatchIndex(ranges, sel);
  return index ? `${index} / ${total} 件` : `${total} 件`;
}

// 選択範囲(複数可)の中の一致をすべて置換する。選択は置換後の範囲を覆い続ける。置換が無ければ false
export function replaceInSelection(view) {
  const { state } = view;
  const query = getSearchQuery(state);
  if (!query.valid) return false;
  const changes = [];
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    const cursor = query.getCursor(state, range.from, range.to);
    for (let m = cursor.next(); !m.done; m = cursor.next()) {
      changes.push({ from: m.value.from, to: m.value.to, insert: expandReplacement(query, m.value) });
    }
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.replace.all" });
  return true;
}
