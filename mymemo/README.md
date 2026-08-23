# mymemo

Mac 向けの軽量テキストエディタ(Tauri 2 + CodeMirror 6)。

## 機能

- **タブ**: 複数ファイルをタブで切り替え(未保存は ● 表示)
- **矩形選択**: `Option + ドラッグ` で矩形選択 → `Cmd+C` / `Cmd+X` で列単位のコピー・切り取り
- **検索・置換**: `Cmd+F` で検索パネル(パネル内の「regexp」トグルで正規表現)。置換もパネル内で可能
- **grep**: `Cmd+Shift+F` でフォルダ横断検索。結果クリックで該当行へジャンプ

## キーバインド

| キー | 動作 |
| --- | --- |
| Cmd+N | 新規タブ |
| Cmd+O | ファイルを開く |
| Cmd+S / Cmd+Shift+S | 保存 / 名前を付けて保存 |
| Cmd+W | タブを閉じる |
| Ctrl+Tab / Ctrl+Shift+Tab | タブ巡回 |
| Cmd+F | 検索・置換パネル |
| Cmd+Shift+F | 複数ファイル grep |
| Option+ドラッグ | 矩形選択 |

## 開発

```sh
npm install
npm run tauri dev     # 開発起動
npm run tauri build   # .app 生成 → src-tauri/target/release/bundle/macos/mymemo.app
```

## テスト

```sh
npm test                        # フロントエンド (vitest): 言語検出・タブ管理
cd src-tauri && cargo test      # Rust: エンコーディング判定・改行コード・grep
```

## grep の仕様・制約

grep は Rust 側で ripgrep のライブラリ(grep-searcher / ignore)を使用。各ファイルをエディタと同じ自動判定(BOM → UTF-8 → CP932 → EUC-JP)でデコードしてから検索するため、CP932 / EUC-JP / UTF-16(BOM 付き)のファイルにも日本語などマルチバイトのパターンがヒットする。

- **エンコーディング判定はヒューリスティック**: CP932 と EUC-JP の両方として妥当なバイト列(EUC-JP のかな中心のテキストなど)は CP932 と判定されることがある。エディタで開いたときと同じ解釈なので、ヒット行番号は常に「開いた結果」と一致する
- **UTF-16 は BOM 付きのみ対象**: BOM のない UTF-16 はバイナリ(NUL バイト含む)としてスキップ
- **20MB を超えるファイルはスキップ**(エンコーディング判定のため全読みする都合)
- **バイナリ(NUL バイトを含むファイル)はスキップ**
- **.gitignore と隠しファイルを尊重**して走査する
- **結果は 5,000 件で打ち切り**(ステータスに「上限で打ち切り」と表示)
