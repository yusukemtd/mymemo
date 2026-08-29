import {
  EditorState,
  StateEffect,
  StateField,
  Compartment,
  Text,
  RangeValue,
  RangeSet,
  RangeSetBuilder,
  MapMode,
  EditorSelection,
  countColumn,
} from "@codemirror/state";
import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  MatchDecorator,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  keymap,
  highlightSpecialChars,
} from "@codemirror/view";
import {
  history,
  defaultKeymap,
  historyKeymap,
  invertedEffects,
  insertTab,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentUnit,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  LanguageDescription,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { getDefaultIndent } from "./indent.js";
import { tags as t } from "@lezer/highlight";
import {
  search,
  searchKeymap,
  highlightSelectionMatches,
  openSearchPanel,
  closeSearchPanel,
  getSearchQuery,
  setSearchQuery,
  SearchQuery,
  findNext,
  findPrevious,
  selectMatches,
  replaceNext,
  replaceAll,
} from "@codemirror/search";

// 色は themes.css のトークンを参照するため、テーマが増えても
// CodeMirror 拡張は dark/light の2バリアントで足りる(切替は {dark} フラグのみ)
const themeSpec = {
  "&": { backgroundColor: "var(--bg-base)", color: "var(--fg-primary)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg-base)",
    color: "var(--ed-gutter-fg)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--ed-activeline)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--ed-activeline)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--ed-selection) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--ed-cursor)" },
  ".cm-panels": { backgroundColor: "var(--bg-surface)", color: "var(--fg-primary)" },
  ".cm-searchMatch": { backgroundColor: "var(--ed-search-match)" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--ed-search-match-selected)" },
  ".cm-selectionMatch": { backgroundColor: "var(--ed-selection-match)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--ed-matching-bracket)",
  },
};

// EditorView.theme は呼ぶたびに CSS を注入するため、モジュールロード時に1回だけ生成する
const cmThemes = {
  dark: EditorView.theme(themeSpec, { dark: true }),
  light: EditorView.theme(themeSpec, { dark: false }),
};
const themeCompartment = new Compartment();
let editorDark = true;

// テーマ切替時: 新規タブ用の極性を更新し、既存 state 向け reconfigure エフェクトのファクトリを返す
export function setEditorDark(dark) {
  editorDark = dark;
  return () => themeCompartment.reconfigure(cmThemes[dark ? "dark" : "light"]);
}

// 言語(シンタックスハイライト)は拡張子から非同期ロードするため Compartment で後から差し替える
const languageCompartment = new Compartment();

// path とファイル先頭行から LanguageDescription を返す(なければ null = プレーンテキスト)
export function detectLanguage(path, firstLine = "") {
  const name = path ? path.split("/").pop() : "";
  let desc = name ? LanguageDescription.matchFilename(languages, name) : null;
  if (!desc && firstLine.startsWith("#!")) {
    // 拡張子なしスクリプト用の shebang 判定
    if (/python/.test(firstLine)) desc = LanguageDescription.matchLanguageName(languages, "python");
    else if (/\b(?:ba|z|k|da)?sh\b/.test(firstLine)) desc = LanguageDescription.matchLanguageName(languages, "shell");
  }
  return desc;
}

// ロード済み LanguageSupport(null でプレーンテキスト)を適用する reconfigure エフェクト
export function languageEffect(support) {
  return languageCompartment.reconfigure(support ?? []);
}

// 色は themes.css の --syn-* トークンを参照するため、単一定義で全テーマに追従する
const highlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: t.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: t.number, color: "var(--syn-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.variableName, t.definition(t.variableName)], color: "var(--syn-variable)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.operator, t.punctuation], color: "var(--syn-operator)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.bool, t.atom, t.null, t.constant(t.variableName)], color: "var(--syn-constant)" },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: "var(--syn-meta)" },
  { tag: [t.regexp, t.escape], color: "var(--syn-regexp)" },
  { tag: t.heading, color: "var(--syn-heading)", fontWeight: "bold" },
  { tag: t.link, color: "var(--syn-heading)", textDecoration: "underline" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);

// カスタム検索・置換パネル(日本語、単語単位なし、閉じるボタン付き)
function createSearchPanel(view) {
  const dom = document.createElement("div");
  dom.className = "mm-search";

  const row1 = document.createElement("div");
  row1.className = "mm-search-row";
  const row2 = document.createElement("div");
  row2.className = "mm-search-row";
  dom.append(row1, row2);

  const searchInput = document.createElement("input");
  searchInput.placeholder = "検索";
  const replaceInput = document.createElement("input");
  replaceInput.placeholder = "置換";

  const mkButton = (label, handler, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = cls;
    b.addEventListener("click", () => {
      commit();
      handler(view);
      view.focus();
    });
    return b;
  };
  const mkCheckbox = (label) => {
    const wrap = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", commit);
    wrap.append(cb, document.createTextNode(label));
    return [wrap, cb];
  };

  // チェックボックスは「正規表現」「大文字小文字を区別」の順
  const [regexWrap, regexCb] = mkCheckbox("正規表現");
  const [caseWrap, caseCb] = mkCheckbox("大文字小文字を区別");

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.className = "mm-search-close";
  closeBtn.title = "閉じる (Esc)";
  closeBtn.addEventListener("click", () => closeSearchPanel(view));

  const spacer = document.createElement("span");
  spacer.className = "mm-search-spacer";

  row1.append(
    searchInput,
    mkButton("前へ", findPrevious),
    mkButton("次へ", findNext),
    mkButton("すべて選択", selectMatches),
    regexWrap,
    caseWrap,
    spacer,
    closeBtn
  );
  row2.append(
    replaceInput,
    mkButton("置換", replaceNext),
    mkButton("すべて置換", replaceAll)
  );

  function commit() {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: searchInput.value,
          replace: replaceInput.value,
          regexp: regexCb.checked,
          caseSensitive: caseCb.checked,
        })
      ),
    });
  }
  searchInput.addEventListener("input", commit);
  replaceInput.addEventListener("input", commit);

  dom.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === "Enter" && e.target === searchInput) {
      e.preventDefault();
      commit();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === "Enter" && e.target === replaceInput) {
      e.preventDefault();
      commit();
      replaceNext(view);
    }
  });

  const q = getSearchQuery(view.state);
  searchInput.value = q.search;
  replaceInput.value = q.replace;
  regexCb.checked = q.regexp;
  caseCb.checked = q.caseSensitive;

  return {
    dom,
    top: true,
    mount() {
      searchInput.focus();
      searchInput.select();
    },
  };
}

// 検索パネルなど CodeMirror UI の日本語化
const japanesePhrases = EditorState.phrases.of({
  Find: "検索",
  Replace: "置換",
  next: "次へ",
  previous: "前へ",
  all: "すべて選択",
  "match case": "大文字小文字を区別",
  "by word": "単語単位",
  regexp: "正規表現",
  replace: "置換",
  "replace all": "すべて置換",
  close: "閉じる",
  "current match": "現在のマッチ",
  "replaced $ matches": "$ 件置換しました",
  "replaced match on line $": "$ 行目のマッチを置換しました",
  "on line": "行",
  "Go to line": "行へ移動",
  go: "移動",
});

// grep 結果ジャンプ時の行ハイライト
export const setJumpHighlight = StateEffect.define();
const jumpHighlightField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setJumpHighlight)) {
        deco =
          e.value == null
            ? Decoration.none
            : Decoration.set([
                Decoration.line({ class: "cm-grep-jump" }).range(e.value),
              ]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// --- 改行コード(行ごとに保持) ---
// ファイルは改行コードが混在していてもそのまま扱う。CodeMirror の Text は改行を "\n" として
// しか持てないため、各行の改行コード(LF/CR/CRLF)は行末位置に置いた RangeSet のマーカーで
// 別管理し、編集に合わせて移動・削除・追加する。保存時は docWithLineEndings() で元に戻す
export const EOL_KINDS = ["LF", "CRLF", "CR"];
const EOL_CHARS = { LF: "\n", CR: "\r", CRLF: "\r\n" };

class EolMarker extends RangeValue {
  constructor(eol) {
    super();
    this.eol = eol;
  }
  eq(other) {
    return other.eol === this.eol;
  }
}
EolMarker.prototype.point = true;
EolMarker.prototype.startSide = EolMarker.prototype.endSide = 1; // 行末への挿入では後ろへ動く
EolMarker.prototype.mapMode = MapMode.TrackAfter; // 直後の "\n" が消えたらマーカーも消える
const eolMarkers = Object.fromEntries(EOL_KINDS.map((k) => [k, new EolMarker(k)]));

const emptyCounts = () => ({ LF: 0, CRLF: 0, CR: 0 });

// 全行を同じ改行コードにしたマーカー集合
function buildUniform(doc, eol) {
  const builder = new RangeSetBuilder();
  const counts = emptyCounts();
  for (let i = 1; i < doc.lines; i++) {
    builder.add(doc.line(i).to, doc.line(i).to, eolMarkers[eol]);
  }
  counts[eol] = doc.lines - 1;
  return { set: builder.finish(), counts };
}

// pos にある改行のマーカー(なければ null)
function markerAt(set, pos) {
  let found = null;
  set.between(pos, pos, (from, _to, m) => {
    if (from === pos) {
      found = m.eol;
      return false;
    }
  });
  return found;
}

// 改行を新しく挿入するときの改行コード: 挿入先の行のもの → 直前の行のもの → fallback
function defaultEolAt(doc, set, pos, fallback) {
  const line = doc.lineAt(pos);
  let eol = markerAt(set, line.to);
  if (eol == null && line.number > 1) eol = markerAt(set, line.from - 1);
  return eol ?? fallback;
}

// 生テキスト(改行コード混在可)を Text と改行マーカーに分解する
export function parseDocument(raw) {
  const lines = [];
  const builder = new RangeSetBuilder();
  const counts = emptyCounts();
  const re = /\r\n|\r|\n/g;
  let last = 0;
  let pos = 0;
  let m;
  while ((m = re.exec(raw))) {
    const line = raw.slice(last, m.index);
    lines.push(line);
    pos += line.length;
    const eol = m[0] === "\n" ? "LF" : m[0] === "\r" ? "CR" : "CRLF";
    builder.add(pos, pos, eolMarkers[eol]);
    counts[eol]++;
    pos += 1;
    last = m.index + m[0].length;
  }
  lines.push(raw.slice(last));
  return { doc: Text.of(lines), eol: { set: builder.finish(), counts, fallback: "LF" } };
}

// 全行の改行コードを統一する(別名保存・「編集 > 改行コードを変換」)。
// 既にその改行コードで揃っていれば何もしない(未保存扱いにも undo 履歴にも残さない)
export const setAllLineEndings = StateEffect.define();
// undo/redo 用: 改行マーカーをまとめて元に戻す({ entries: [{ pos, eol }], fallback })。
// fallback は null なら変更しない。同じ位置が複数あれば後のものを優先する
const restoreLineEndings = StateEffect.define({
  map: ({ entries, fallback }, mapping) => ({
    entries: entries.map(({ pos, eol }) => ({ pos: mapping.mapPos(pos, 1), eol })),
    fallback,
  }),
});

// 既に eol だけで揃っているか(改行が 1 つもなければ fallback で判定)
function isUniform(counts, fallback, eol) {
  const total = EOL_KINDS.reduce((n, k) => n + counts[k], 0);
  return counts[eol] === total && fallback === eol;
}

// { set: RangeSet<EolMarker>, counts: {LF, CRLF, CR}, fallback }
// fallback は改行が1つもないときに使う改行コード
export const eolField = StateField.define({
  create: (state) => ({ ...buildUniform(state.doc, "LF"), fallback: "LF" }),
  update(value, tr) {
    let { set, counts, fallback } = value;
    let changed = false;
    if (tr.docChanged) {
      const oldSet = set;
      const oldDoc = tr.startState.doc;
      counts = { ...counts };
      const adds = [];
      tr.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        // 削除範囲内の改行のマーカーは map で消える。その改行コードは同じ変更で挿入される
        // 改行へ順に引き継ぐ(複数行にまたがる置換で改行コードが変わらないように)
        const removed = [];
        if (toA > fromA) {
          oldSet.between(fromA, toA, (pos, _to, m) => {
            if (pos < toA) removed.push(m.eol);
          });
        }
        for (const eol of removed) counts[eol]--;
        let def = null;
        let pos = fromB;
        for (let i = 1; i < inserted.lines; i++) {
          pos += inserted.line(i).length;
          const eol =
            removed[i - 1] ?? (def ??= defaultEolAt(oldDoc, oldSet, fromA, fallback));
          adds.push(eolMarkers[eol].range(pos));
          counts[eol]++;
          pos += 1;
        }
      });
      set = set.map(tr.changes);
      if (adds.length) set = set.update({ add: adds, sort: true });
      changed = true;
    }
    for (const e of tr.effects) {
      if (e.is(setAllLineEndings)) {
        if (isUniform(counts, fallback, e.value)) continue;
        ({ set, counts } = buildUniform(tr.state.doc, e.value));
        fallback = e.value;
        changed = true;
      } else if (e.is(restoreLineEndings)) {
        const doc = tr.state.doc;
        // 改行のある位置だけを対象にし、現在と同じ改行コードのものは除く
        const target = new Map();
        for (const { pos, eol } of e.value.entries) {
          if (pos < doc.length && doc.lineAt(pos).to === pos) target.set(pos, eol);
        }
        for (const [pos, eol] of target) {
          if (markerAt(set, pos) === eol) target.delete(pos);
        }
        if (target.size) {
          if (!changed) counts = { ...counts };
          const adds = [];
          for (const [pos, eol] of target) {
            const prev = markerAt(set, pos);
            if (prev) counts[prev]--;
            counts[eol]++;
            adds.push(eolMarkers[eol].range(pos));
          }
          set = set.update({ filter: (from) => !target.has(from), add: adds, sort: true });
          changed = true;
        }
        if (e.value.fallback != null && e.value.fallback !== fallback) {
          fallback = e.value.fallback;
          changed = true;
        }
      }
    }
    return changed ? { set, counts, fallback } : value;
  },
});

// undo 用: 変更で消える改行と、統一・復元で変わる改行の改行コードを記録し、取り消し時に元に戻す
const eolHistory = invertedEffects.of((tr) => {
  const { set, counts, fallback } = tr.startState.field(eolField);
  const entries = [];
  let restoreFallback = null;
  if (tr.docChanged) {
    tr.changes.iterChanges((fromA, toA) => {
      if (toA <= fromA) return;
      set.between(fromA, toA, (pos, _to, m) => {
        if (pos < toA) entries.push({ pos, eol: m.eol });
      });
    });
  }
  for (const e of tr.effects) {
    if (e.is(setAllLineEndings)) {
      if (isUniform(counts, fallback, e.value)) continue; // 適用側と同じ判定で no-op
      set.between(0, tr.startState.doc.length, (pos, _to, m) => {
        if (m.eol !== e.value) entries.push({ pos, eol: m.eol });
      });
      restoreFallback = fallback;
    } else if (e.is(restoreLineEndings) && !tr.docChanged) {
      // 統一の undo(効果だけのトランザクション)を redo できるよう、戻す前の改行コードを記録する。
      // 本文の変更を伴う undo では、復元される改行は redo の変更で消えるので記録しない
      for (const { pos, eol } of e.value.entries) {
        const prev = markerAt(set, pos);
        if (prev && prev !== eol) entries.push({ pos, eol: prev });
      }
      if (e.value.fallback != null && e.value.fallback !== fallback) restoreFallback = fallback;
    }
  }
  if (!entries.length && restoreFallback == null) return [];
  return [restoreLineEndings.of({ entries, fallback: restoreFallback })];
});

// 保存用: 各行の改行コードを復元したテキスト。override を渡すと全行その改行コードにする
export function docWithLineEndings(state, override = null) {
  const doc = state.doc;
  const { set, fallback } = state.field(eolField);
  const it = set.iter();
  const out = [];
  for (let i = 1; i < doc.lines; i++) {
    const line = doc.line(i);
    while (it.value && it.from < line.to) it.next();
    let eol = fallback;
    if (it.value && it.from === line.to) {
      eol = it.value.eol;
      it.next();
    }
    out.push(line.text, EOL_CHARS[override ?? eol]);
  }
  out.push(doc.line(doc.lines).text);
  return out.join("");
}

// { counts, dominant, mixed }。dominant は最多の改行コード(改行がなければ fallback)
export function lineEndingSummary(state) {
  const { counts, fallback } = state.field(eolField);
  const present = EOL_KINDS.filter((k) => counts[k] > 0);
  const dominant = present.length
    ? present.reduce((a, b) => (counts[b] > counts[a] ? b : a))
    : fallback;
  return { counts, dominant, mixed: present.length > 1 };
}

// ステータスバー用ラベル: "LF" / "混在 (CRLF 12, LF 3)"
export function describeLineEndings(state) {
  const { counts, dominant, mixed } = lineEndingSummary(state);
  if (!mixed) return dominant;
  const parts = EOL_KINDS.filter((k) => counts[k] > 0)
    .sort((a, b) => counts[b] - counts[a])
    .map((k) => `${k} ${counts[k]}`);
  return `混在 (${parts.join(", ")})`;
}

// --- 空白文字・改行の可視化 ---
// 行末記号(サクラエディタ等の慣例: LF ↓ / CR ← / CRLF ↵)
export const EOL_GLYPHS = { LF: "↓", CR: "←", CRLF: "↵" };

class EolWidget extends WidgetType {
  constructor(lineEnding) {
    super();
    this.lineEnding = lineEnding;
  }
  eq(other) {
    return other.lineEnding === this.lineEnding;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "mm-ws-eol";
    span.textContent = EOL_GLYPHS[this.lineEnding];
    span.title = this.lineEnding;
    return span;
  }
}

const eolWidgets = {};
for (const eol of EOL_KINDS) {
  eolWidgets[eol] = Decoration.widget({ widget: new EolWidget(eol), side: 1 });
}

// ranges(表示範囲)に含まれる改行マーカーの位置に、その改行コードの記号を置く。
// 最終行は後ろに改行がないので付かない(= 末尾改行の有無も見て分かる)
export function eolDecorations(set, ranges) {
  const builder = new RangeSetBuilder();
  let last = -1;
  for (const { from, to } of ranges) {
    set.between(from, to, (pos, _to, m) => {
      if (pos > last) {
        builder.add(pos, pos, eolWidgets[m.eol]);
        last = pos;
      }
    });
  }
  return builder.finish();
}

const eolPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.build(view);
    }
    build(view) {
      return eolDecorations(view.state.field(eolField).set, view.visibleRanges);
    }
    update(u) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.state.field(eolField) !== u.startState.field(eolField)
      ) {
        this.decorations = this.build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// 空白 1 文字ごとに種類別のクラスを付ける(見た目は style.css の .mm-ws-*)。
// 連続した空白をまとめず 1 文字ずつにするのは、シンタックスハイライトの
// トークン境界で span が分割されても表示が崩れないようにするため
const wsDecos = {
  " ": Decoration.mark({ class: "mm-ws-space" }),
  "\t": Decoration.mark({ class: "mm-ws-tab" }),
  "\u00a0": Decoration.mark({ class: "mm-ws-nbsp" }),
  "\u3000": Decoration.mark({ class: "mm-ws-ideo" }),
};
const wsMatcher = new MatchDecorator({
  regexp: /[ \t\u00a0\u3000]/g,
  decoration: (m) => wsDecos[m[0]],
});
const wsPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = wsMatcher.createDeco(view);
    }
    update(u) {
      this.decorations = wsMatcher.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations }
);

const whitespaceExtension = [wsPlugin, eolPlugin];
const whitespaceCompartment = new Compartment();
let showWhitespace = true;

// 表示切替: 新規タブ用の既定値を更新し、既存 state 向け reconfigure エフェクトのファクトリを返す
export function setShowWhitespace(show) {
  showWhitespace = show;
  return () => whitespaceCompartment.reconfigure(show ? whitespaceExtension : []);
}

// --- 文字数(ステータスバー表示用) ---
// 改行を除いた Unicode コードポイント数。CodeMirror の doc.length は UTF-16 単位なので
// サロゲートペア(絵文字など)を 1 文字として数え直す
export function countChars(text) {
  const pairs = text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0;
  const breaks = text.match(/[\r\n]/g)?.length ?? 0;
  return text.length - pairs - breaks;
}

// 全文の文字数。毎回数え直すと巨大ファイルで入力のたびに全文走査になるため、
// 変更分(削除された範囲と挿入されたテキスト)だけ差し引きして保持する
export const charCountField = StateField.define({
  create: (state) => countChars(state.doc.toString()),
  update(count, tr) {
    if (!tr.docChanged) return count;
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      if (toA > fromA) count -= countChars(tr.startState.doc.sliceString(fromA, toA));
      if (inserted.length) count += countChars(inserted.toString());
    });
    return count;
  },
});

export function charCount(state) {
  return state.field(charCountField);
}

// 選択範囲の文字数(複数選択は合計。選択が無ければ 0)
export function selectionCharCount(state) {
  let n = 0;
  for (const r of state.selection.ranges) {
    if (!r.empty) n += countChars(state.doc.sliceString(r.from, r.to));
  }
  return n;
}

// ステータスバー用ラベル: "1,234 文字" / 選択中は "選択 12 / 1,234 文字"
export function describeCharCount(state) {
  const total = charCount(state).toLocaleString("ja-JP");
  const sel = selectionCharCount(state);
  return sel > 0 ? `選択 ${sel.toLocaleString("ja-JP")} / ${total} 文字` : `${total} 文字`;
}

// --- インデント(タブ幅・ソフトタブ)。タブごとに違うので state ごとに Compartment で持つ ---
const indentCompartment = new Compartment();

// tabSize はタブ文字の表示幅。indentUnit はインデント操作(選択範囲の Tab / 自動インデント)の単位で、
// ソフトタブならタブ幅ぶんのスペース、そうでなければタブ文字
function indentExtension({ tabSize, softTabs }) {
  return [EditorState.tabSize.of(tabSize), indentUnit.of(softTabs ? " ".repeat(tabSize) : "\t")];
}

export function indentEffect(settings) {
  return indentCompartment.reconfigure(indentExtension(settings));
}

// state に設定されているインデント設定
export function indentOf(state) {
  return { tabSize: state.tabSize, softTabs: state.facet(indentUnit) !== "\t" };
}

// Tab キー: 選択範囲があればインデント、ソフトタブなら次のタブ位置までスペース、それ以外はタブ文字
export const insertTabKey = (view) => {
  const { state } = view;
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);
  if (state.facet(indentUnit) === "\t") return insertTab(view);
  const size = state.tabSize;
  view.dispatch(
    state.changeByRange((range) => {
      const line = state.doc.lineAt(range.head);
      const col = countColumn(line.text.slice(0, range.head - line.from), size);
      const spaces = " ".repeat(size - (col % size));
      return {
        changes: { from: range.head, insert: spaces },
        range: EditorSelection.cursor(range.head + spaces.length),
      };
    }),
    { scrollIntoView: true, userEvent: "input" }
  );
  return true;
};

// --- 行の折り返し(表示 > 行を折り返す) ---
const wrapCompartment = new Compartment();
let lineWrap = false;

// 折り返し切替: 新規タブ用の既定値を更新し、既存 state 向け reconfigure エフェクトのファクトリを返す
export function setLineWrap(wrap) {
  lineWrap = wrap;
  return () => wrapCompartment.reconfigure(wrap ? EditorView.lineWrapping : []);
}

// エディタ拡張一式。dirty 通知用の onChange と、このタブのインデント設定を受け取る
export function baseExtensions(onChange, indent = getDefaultIndent()) {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(), // Alt+ドラッグで矩形選択
    crosshairCursor(),
    bracketMatching(),
    languageCompartment.of([]), // 言語は非同期で後から reconfigure される
    syntaxHighlighting(highlightStyle),
    indentOnInput(), // 言語なしでは no-op。indentUnit の4スペースを尊重
    highlightSelectionMatches(),
    search({ top: true, createPanel: createSearchPanel }),
    indentCompartment.of(indentExtension(indent)),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      // 既定では Tab はフォーカス移動。タブ文字(ソフトタブならスペース)を入力できるようにする
      // (選択範囲があればインデント、Shift+Tab でインデント解除)
      { key: "Tab", run: insertTabKey, shift: indentLess },
    ]),
    themeCompartment.of(cmThemes[editorDark ? "dark" : "light"]),
    japanesePhrases,
    jumpHighlightField,
    charCountField,
    eolField,
    eolHistory,
    whitespaceCompartment.of(showWhitespace ? whitespaceExtension : []),
    wrapCompartment.of(lineWrap ? EditorView.lineWrapping : []),
    EditorView.updateListener.of((u) => {
      // 改行コードの統一とその undo/redo は本文を変えないが、保存内容が変わるので変更扱いにする
      const eolChanged = u.state.field(eolField) !== u.startState.field(eolField);
      if (u.docChanged || eolChanged) onChange();
      if (u.docChanged || u.selectionSet || eolChanged) {
        window.dispatchEvent(new CustomEvent("cursor-moved"));
      }
    }),
  ];
}

// raw は改行コード混在可の生テキスト。改行はマーカーに分離して eolField の初期値にする
export function createEditorState(raw, onChange, indent = getDefaultIndent()) {
  const { doc, eol } = parseDocument(raw);
  return EditorState.create({
    doc,
    extensions: [baseExtensions(onChange, indent), eolField.init(() => eol)],
  });
}

export function createView(parent, state) {
  return new EditorView({ state, parent });
}

export { openSearchPanel };
