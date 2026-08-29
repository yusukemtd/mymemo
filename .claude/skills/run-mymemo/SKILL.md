---
name: run-mymemo
description: mymemo(Tauri 2 + CodeMirror 6 の macOS テキストエディタ)を起動・操作・スクリーンショットして動作確認する。「アプリを起動して」「この変更の動作を確認して」「スクリーンショットを撮って」「run / start / launch / screenshot mymemo」で使う。フロントは driver.mjs(Chrome headless + Tauri IPC モック)、本物のアプリは native.mjs で駆動する。
---

# mymemo を起動して操作する

パスはすべて **リポジトリ直下**基準。mymemo は Tauri 2(Rust)+ Vanilla JS/CodeMirror 6(Vite)の macOS エディタで、
UI ロジックはほぼ `src/*.js` にある。動作確認は 2 段構え:

| 経路 | 何を動かすか | 使いどころ |
| --- | --- | --- |
| **driver.mjs**(主) | Vite dev サーバー + Chrome headless。`window.__TAURI_INTERNALS__` をモックし、`read_file` / `write_file` / `grep_search` は Node の fs に繋ぐ | `src/*.js` の変更の確認。ファイル操作・タブ・検索・grep・テーマ・スクリーンショットまで再現できる。1 回 3〜4 秒 |
| **native.mjs**(副) | `npm run tauri dev` で本物のウィンドウを出し、`screencapture` で撮る | Rust 側(メニュー・IPC・ACL)を含めて実際に起動するかの確認。初回 20 秒前後 |

## 前提(このマシンで確認済み)

- macOS 26.5 / Node 26.7 / npm 11 / cargo 1.97(`rustup component add rustfmt clippy` 導入済み)
- Google Chrome(`/Applications/Google Chrome.app`)。別の場所なら `CHROME=<binary> node ...`
- 依存パッケージの追加は不要(Node 組み込みの WebSocket / fetch だけで動く)
- `native.mjs` は端末(Claude を動かしているプロセス)に「画面収録」と「アクセシビリティ」の権限が要る。この環境では両方付いていた

```bash
npm install
```

## Run(エージェント経路): driver.mjs

stdin に 1 行 1 コマンドを流す。終わると Chrome と vite を落とし、一時プロファイルも消す。

```bash
mkdir -p /tmp/mymemo-run && printf 'メモ 1 行目\n2 行目\n' > /tmp/mymemo-run/memo.txt
node .claude/skills/run-mymemo/driver.mjs <<'EOF'
open /tmp/mymemo-run/memo.txt
status
key End
type  追記\n
doc
save
saveas /tmp/mymemo-run/memo-crlf.txt UTF-8 CRLF
status
ss /tmp/mymemo-run/shot.png
quit
EOF
od -c /tmp/mymemo-run/memo-crlf.txt | head -3
```

期待: `status` が `1 行, 1 列 UTF-8 LF` → 別名保存後 `2 行, 1 列 UTF-8 CRLF`、`doc` の 1 行目が `メモ 1 行目追記`、`od` に `\r \n` が出る、`shot.png` にダークテーマのエディタが写る。

主なコマンド(`help` で全部):

| コマンド | 内容 |
| --- | --- |
| `open <path>` / `drop <path>` | ファイルを開く(「開く」ダイアログ経由 / ドラッグ&ドロップ経由)。実ファイルを読む |
| `type <text>` | フォーカス中の要素に入力。`\n` で改行。何もフォーカスしていなければエディタへ |
| `key <combo>` | `Enter` `Backspace` `End` `ArrowDown` `Meta+z` `Meta+Shift+z` `Escape` … |
| `click <selector>` | 要素中心をクリック |
| `menu <id>` | ネイティブメニュー相当。`new` `open` `save` `save_as` `revert` `close_tab` `find` `grep` `goto_line` `toggle_whitespace` `toggle_wrap` `toggle_fold_gutter` `toggle_preview`(Markdown プレビュー。`#preview` に描画) `toggle_close_brackets` `toggle_word_completion` `fold_code` / `unfold_code` / `fold_all` / `unfold_all` `zoom_in` `zoom_out` `zoom_reset` `quit` `theme:light` `theme:solarized-dark` `open_enc:CP932` `recent:0`(最近使ったファイルの 0 番目) `recent_clear` `tabsize:2`(タブ幅) `soft_tabs`(ソフトタブ切替) `transform:sort_asc` / `sort_desc` / `unique` / `remove_blank`(テキスト変換) `set_enc:CP932`(保存時の文字コード変更) `md:bold` / `italic` / `strike` / `code` / `link`(Markdown 書式) `convert_eol:CRLF` |
| `dialog open <path\|null>` / `dialog confirm <true\|false>` / `dialog save <path> [enc] [KEEP\|LF\|CRLF\|CR]` | 次に出るダイアログの戻り値を仕込む |
| `save` / `saveas <path> [enc] [eol]` | 保存して dirty が消えるまで待つ |
| `doc` / `tabs` / `status` / `text <sel>` / `eval <js>` | 状態の観察。`eval` では `window.__mymemo.view()` で EditorView が取れる |
| `calls` | モックが受けた `invoke` の一覧(引数付き)を表示してクリア。Rust 側に何が渡るかの確認に |
| (grep の要素) | `#grep-glob`(ファイル名の絞り込み)、`#grep-replace` + `#grep-replace-all`(すべて置換。`dialog confirm` で確認を仕込む)。モックの glob と置換は簡易実装で、文字コード保持などは `cargo test` で確認する |
| `emit <event> <json>` | 任意の Tauri イベントを発火。Finder の「このアプリケーションで開く」は `emit open-files ["/path/a.txt"]` で再現できる(起動と同時に渡された分を引き取る `take_pending_open_files` はモックでは常に空) |
| `ss <file.png>` | スクリーンショット(1100x750) |
| `waitfor <selector> [ms]` / `wait <ms>` | 待ち |

よく使う流れ(すべてこのセッションで実行して動いた):

```bash
node .claude/skills/run-mymemo/driver.mjs <<'EOF'
menu new
type dirty text
dialog confirm false
menu close_tab
tabs
dialog confirm true
menu close_tab
tabs
menu grep
dialog open /tmp/mymemo-run
click #grep-dir-btn
click #grep-input
type 行目
key Enter
waitfor .grep-hit
text #grep-status
click .grep-hit:nth-of-type(3)
waitfor .cm-grep-jump 2000
status
menu find
click .mm-search input
type 行目
key Enter
eval [...document.querySelectorAll(".cm-searchMatch")].length
menu theme:light
ss /tmp/mymemo-run/light.png
quit
EOF
```

期待: 1 回目の `close_tab` は残り(confirm false)、2 回目で閉じる。grep は `4 件`(memo-crlf.txt と memo.txt に 2 件ずつ)、ジャンプ後 `status` が `3 行, 1 列 UTF-8 CRLF`(memo-crlf.txt の 3 行目)。検索マッチは `2`。
`.grep-hit:nth-of-type(3)` はファイル名の `.grep-file` div も数えるので「3 番目のヒット」ではない点に注意(結果の並びは `eval [...document.querySelectorAll("#grep-results > div")].map(e => e.textContent)` で見る)。

## Run(副経路): native.mjs — 本物のアプリ

```bash
node .claude/skills/run-mymemo/native.mjs --shot /tmp/mymemo-run/native.png
```

`npm run tauri dev`(vite + `cargo run`)を起動 → `pgrep -x mymemo` で本体を待つ → System Events でウィンドウ位置を取って
`screencapture -R` で撮る → `pkill -x mymemo` で終了(tauri CLI が vite も道連れに終了する)。
`--keep` で起動したままにできる(止めるときは `pkill -x mymemo`)。`--type "text"` はキー入力が届くかの確認用(後述の IME 注意)。

## Run(人間向け)

```bash
npm run tauri dev
```

ウィンドウが開いて待ち続ける。Cmd+Q で終了。`npm run tauri build`(README 記載、`src-tauri/target/release/bundle/macos/mymemo.app`)はこのセッションでは実行していない。

## Test

```bash
npm test                        # vitest: 63 passed(0.6 秒)
cd src-tauri && cargo test      # 22 passed(エンコーディング判定・読み書き・grep)
```

driver.mjs のモックは文字コードを簡易判定(BOM → UTF-8 fatal → CP932 fallback)しかしないので、
CP932 / EUC-JP / UTF-16 の判定と書き込みは `cargo test`(`src-tauri/src/file_io.rs`)で確認する。モックの `write_file` は CP932 / EUC-JP をエラーにする。

## Gotchas

- **plugin-dialog の `confirm()` は真偽値ではなく文字列で判定する**: `invoke("plugin:dialog|message", {buttons:"OkCancel"})` の戻り値を `=== "Ok"` で比較する。モックが `true` を返しても閉じない。`dialog confirm` はこれを踏まえて `"Ok"/"Cancel"` を返している。
- **`menu find` 直後は検索欄にフォーカスが無い**: 独自パネル(`.mm-search`)なので、`type` の前に `click .mm-search input` が必要。しないと本文に入る。
- **`type` は「今フォーカスしている要素」に入る**: grep の入力欄に入れたいときは先に `click #grep-input`。
- **CodeMirror の EditorView は DOM の `cmTile.root.view`**(このバージョン。旧版は `cmView.rootView.view`)。`window.__mymemo.view()` が両対応。
- **grep ジャンプ行のクラスは `.cm-grep-jump`** で 1.5 秒後に消える。`waitfor .cm-grep-jump 2000` で拾える。
- **native.mjs の `--type` は IME を通る**: 入力ソースが日本語のままだと `native hello` が「ナチヴェへっぉ」+ 変換候補になる(スクリーンショットで確認)。文字列の検証は driver.mjs で行い、native は起動確認と見た目だけに使う。
- **native.mjs はウィンドウ出現までの間 System Events が `-1728` を返す**(`process "mymemo" を取り出すことはできません`)。0.5 秒間隔で最大 30 秒再試行する。
- ディスク上の変更検知は `emit tauri://focus true`(ウィンドウのフォーカス復帰)で起動できる。ファイルの書き換えは driver と並行して `(sleep 3; echo x >> file) &` のようにシェル側から行う。
- driver.mjs は `localStorage` が空の新規プロファイルで始まるので、テーマは常に `dark`・空白文字表示は ON・セッション復元なし(無題タブ 1 つ)から始まる。セッション復元は `eval localStorage.setItem("mymemo.session", ...)` → `eval location.reload()` → `wait 2000` で確認できる(モックはページ再読み込みでも再注入される)。
- driver.mjs はポート 1420 が既に応答していればそれを再利用する(`npm run dev` を別で動かしていても可)。`native.mjs` 実行中は 1420 が使われているので driver.mjs と同時に走らせない。
- Bash から driver.mjs を heredoc で呼ぶスクリプトをさらに heredoc で書くとき、外側の終端に `EOF` を使うと driver 用の `EOF` 行で切れる(この文書を書くときに踏んだ)。外側は別の終端語にする。zsh は `noclobber` で `>` の上書きを拒むので `>|`。

## Troubleshooting

- `npm run tauri dev` が `failed to read plugin permissions: failed to read file '/Users/yusuke/Documents/Tools/tools/mymemo/src-tauri/target/debug/build/tauri-*/out/permissions/...'`(code 101)で落ちる
  → リポジトリ移動前の絶対パスが `target/` 内の tauri クレートのビルドスクリプト出力に残っている。素の `cargo build` は通るのに `tauri dev` だけ落ちる(TAURI_CONFIG env の変化で build.rs が再実行される)。該当クレートだけ消して再ビルド:
  ```bash
  cd src-tauri && cargo clean -p tauri -p tauri-plugin-dialog -p tauri-plugin-fs -p tauri-build
  ```
  (約 400MB 削除、再ビルド込みで次回起動 20 秒)
- `!! mymemo が既に起動しています` → `pkill -x mymemo`
- driver.mjs で `!! タイムアウト(5000ms): タブ ... が開く` → パスが存在しないか、`open` の直前に `dialog open` を上書きしている。`calls` で `read_file` に渡ったパスを確認
- driver.mjs で `!! Chrome の DevTools が 15 秒以内に起動しませんでした` → `CHROME` のパスを確認(`"$CHROME" --version`)
