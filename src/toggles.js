import { invoke } from "@tauri-apps/api/core";
import { applyToAllTabs } from "./tabs.js";
import {
  setShowWhitespace,
  setLineWrap,
  setFoldGutter,
  setCloseBrackets,
  setWordCompletion,
} from "./editor.js";
import { setPreviewVisible } from "./preview.js";

// 表示・編集の ON/OFF 設定の共通部品。1 つの設定 = editor.js の setter(新規タブ用の既定値を更新し、
// 既存 state 向けの reconfigure エフェクトを返す)または onChange(CodeMirror 拡張以外の反映)
// + ネイティブメニューのチェック同期(Rust 側の set_toggle。id はメニュー項目の ID と同じ)+ localStorage 永続化

export function createToggle({ id, storageKey, setter = null, onChange = null, defaultValue }) {
  let value = defaultValue;
  const sync = () => invoke("set_toggle", { id, on: value }).catch(console.error);
  const reflect = (initial) => {
    if (setter) {
      const effects = setter(value);
      if (!initial) applyToAllTabs(effects); // 起動時はタブ未生成なので reconfigure は不要
    }
    onChange?.(value);
  };
  return {
    id,
    get: () => value,
    apply(on) {
      value = Boolean(on);
      try {
        localStorage.setItem(storageKey, value ? "1" : "0");
      } catch {}
      reflect(false);
      sync();
    },
    toggle() {
      this.apply(!value);
    },
    // 保存済み設定の復元。エディタ生成(createView)より前に呼ぶこと(初期 state の既定値が決まる)
    init() {
      let saved = null;
      try {
        saved = localStorage.getItem(storageKey);
      } catch {}
      value = saved == null ? defaultValue : saved === "1";
      reflect(true);
      sync();
    },
  };
}

// 空白文字・改行の可視化(既定は表示)。可視化そのものは editor.js / style.css 側にある
export const showWhitespace = createToggle({
  id: "toggle_whitespace",
  storageKey: "mymemo.showWhitespace",
  setter: setShowWhitespace,
  defaultValue: true,
});

// 行の折り返し(既定は折り返さない)
export const lineWrap = createToggle({
  id: "toggle_wrap",
  storageKey: "mymemo.lineWrap",
  setter: setLineWrap,
  defaultValue: false,
});

// 折りたたみガター(既定は表示)。折りたたみ自体とキーは常時有効
export const foldGutter = createToggle({
  id: "toggle_fold_gutter",
  storageKey: "mymemo.foldGutter",
  setter: setFoldGutter,
  defaultValue: true,
});

// 括弧・引用符の自動補完(既定は OFF。散文では邪魔になるため)
export const closeBrackets = createToggle({
  id: "toggle_close_brackets",
  storageKey: "mymemo.closeBrackets",
  setter: setCloseBrackets,
  defaultValue: false,
});

// 単語補完(既定は OFF)
export const wordCompletion = createToggle({
  id: "toggle_word_completion",
  storageKey: "mymemo.wordCompletion",
  setter: setWordCompletion,
  defaultValue: false,
});

// Markdown プレビュー(既定は非表示)。initPreview の後に init すること
export const markdownPreview = createToggle({
  id: "toggle_preview",
  storageKey: "mymemo.preview",
  onChange: setPreviewVisible,
  defaultValue: false,
});

// メニュー項目 ID → 設定
export const TOGGLES = Object.fromEntries(
  [showWhitespace, lineWrap, foldGutter, closeBrackets, wordCompletion, markdownPreview].map((t) => [t.id, t])
);
