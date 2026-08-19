import { EditorState, StateEffect, StateField } from "@codemirror/state";
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
import { bracketMatching, indentUnit } from "@codemirror/language";
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

const darkTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#1e1e1e", color: "#ddd" },
    ".cm-gutters": {
      backgroundColor: "#1e1e1e",
      color: "#666",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "#ffffff0a" },
    ".cm-activeLineGutter": { backgroundColor: "#ffffff0a" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "#3a5a8c88 !important",
    },
    ".cm-cursor": { borderLeftColor: "#fff" },
    ".cm-panels": { backgroundColor: "#2a2a2a", color: "#ddd" },
    ".cm-searchMatch": { backgroundColor: "#e8b75033" },
    ".cm-searchMatch-selected": { backgroundColor: "#e8b75077" },
  },
  { dark: true }
);

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
    highlightSelectionMatches(),
    search({ top: true, createPanel: createSearchPanel }),
    indentUnit.of("    "),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    darkTheme,
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
