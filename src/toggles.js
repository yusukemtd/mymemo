import { invoke } from "@tauri-apps/api/core";
import { applyToAllTabs } from "./tabs.js";
import { setShowWhitespace, setLineWrap } from "./editor.js";

// 表示・編集の ON/OFF 設定の共通部品。1 つの設定 = editor.js の setter(新規タブ用の既定値を更新し、
// 既存 state 向けの reconfigure エフェクトを返す)+ ネイティブメニューのチェック同期(Rust 側の set_toggle。
// id はメニュー項目の ID と同じ)+ localStorage 永続化

export function createToggle({ id, storageKey, setter, defaultValue }) {
  let value = defaultValue;
  const sync = () => invoke("set_toggle", { id, on: value }).catch(console.error);
  return {
    id,
    get: () => value,
    apply(on) {
      value = Boolean(on);
      try {
        localStorage.setItem(storageKey, value ? "1" : "0");
      } catch {}
      applyToAllTabs(setter(value));
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
      setter(value); // タブ未生成なので reconfigure は不要
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

// メニュー項目 ID → 設定
export const TOGGLES = Object.fromEntries([showWhitespace, lineWrap].map((t) => [t.id, t]));
