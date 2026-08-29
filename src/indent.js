import { invoke } from "@tauri-apps/api/core";

// インデント設定(タブ幅・ソフトタブ): タブごとに持ち、ファイルを開いたときは字下げから自動判定する。
// 判定できないとき(無題タブ・字下げの無いファイル)はメニューで最後に選んだ設定を使う(localStorage に保存)。
// エディタへの反映は editor.js の indentEffect、メニューのチェック同期は Rust 側の set_indent

const STORAGE_KEY = "mymemo.indent";
export const TAB_SIZES = [2, 4, 8];
const DEFAULT = { tabSize: 4, softTabs: false };
const DETECT_MAX_LINES = 1000;

let defaults = { ...DEFAULT };

// 不正値を既定値に寄せた { tabSize, softTabs } を返す
export function normalizeIndent(v) {
  const tabSize = TAB_SIZES.includes(Number(v?.tabSize)) ? Number(v.tabSize) : DEFAULT.tabSize;
  return { tabSize, softTabs: Boolean(v?.softTabs) };
}

export function getDefaultIndent() {
  return { ...defaults };
}

export function setDefaultIndent(settings) {
  defaults = normalizeIndent(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
  } catch {}
}

export function initIndent() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
  } catch {}
  defaults = saved ? normalizeIndent(saved) : { ...DEFAULT };
}

// 本文の字下げからインデント設定を推定する。字下げのある行が無ければ null。
// タブ始まりの行がスペース始まりの行以上ならタブ、そうでなければスペース幅を 2 / 4 / 8 から選ぶ
// (最も多くの行の字下げ幅を割り切れる幅。同点なら大きい方)。先頭 1000 行だけ見る
export function detectIndent(text, fallback = defaults) {
  let tabLines = 0;
  let spaceLines = 0;
  const widths = new Map(); // 字下げ幅 → 行数
  let seen = 0;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (++seen > DETECT_MAX_LINES) break;
    if (line[0] === "\t") {
      tabLines++;
    } else if (line[0] === " " && line.trim() !== "") {
      spaceLines++;
      const n = line.length - line.trimStart().length;
      widths.set(n, (widths.get(n) ?? 0) + 1);
    }
  }
  if (tabLines === 0 && spaceLines === 0) return null;
  if (tabLines >= spaceLines) return { tabSize: fallback.tabSize, softTabs: false };
  let best = fallback.tabSize;
  let bestScore = -1;
  for (const w of TAB_SIZES) {
    let score = 0;
    for (const [n, count] of widths) if (n % w === 0) score += count;
    if (score >= bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return { tabSize: best, softTabs: true };
}

// ステータスバー用: "タブ幅 4" / "スペース 2"
export function describeIndent({ tabSize, softTabs }) {
  return softTabs ? `スペース ${tabSize}` : `タブ幅 ${tabSize}`;
}

// ネイティブメニューのチェック状態を合わせる(同じ値なら呼ばない)
let synced = null;
export function syncIndentMenu(settings) {
  const s = normalizeIndent(settings);
  if (synced && synced.tabSize === s.tabSize && synced.softTabs === s.softTabs) return;
  synced = s;
  invoke("set_indent", { tabSize: s.tabSize, softTabs: s.softTabs }).catch(console.error);
}
