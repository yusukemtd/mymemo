import { EditorState, StateEffect, StateField, Compartment } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
  keymap,
  highlightSpecialChars,
} from "@codemirror/view";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  indentUnit,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
  LanguageDescription,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";
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

// エディタ拡張一式。dirty 通知用の onChange を受け取る
export function baseExtensions(onChange) {
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
    indentUnit.of("    "),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    themeCompartment.of(cmThemes[editorDark ? "dark" : "light"]),
    japanesePhrases,
    jumpHighlightField,
    EditorView.updateListener.of((u) => {
      if (u.docChanged) onChange();
      if (u.docChanged || u.selectionSet) {
        window.dispatchEvent(new CustomEvent("cursor-moved"));
      }
    }),
  ];
}

export function createEditorState(doc, onChange) {
  return EditorState.create({ doc, extensions: baseExtensions(onChange) });
}

export function createView(parent, state) {
  return new EditorView({ state, parent });
}

export { openSearchPanel };
