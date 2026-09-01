mod dialog;
mod file_io;
mod grep;
mod open_files;

use std::collections::HashMap;
use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, ContextMenu, MenuBuilder,
    MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder,
};
use tauri::{Emitter, Manager};

// 最後のタブを閉じたときにフロントエンドから呼ばれる
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

// 「表示 > テーマ」の CheckMenuItem ハンドル(チェック状態の同期用)
struct ThemeMenuItems(Vec<CheckMenuItem<tauri::Wry>>);

// テーマ確定時にフロントエンドから呼ばれる: メニューチェックの排他同期 + ウィンドウ chrome 切替
#[tauri::command]
fn set_theme(
    app: tauri::AppHandle,
    items: tauri::State<ThemeMenuItems>,
    theme: String,
    dark: bool,
) -> Result<(), String> {
    let target = format!("theme:{theme}");
    for item in &items.0 {
        item.set_checked(item.id().0 == target)
            .map_err(|e| e.to_string())?;
    }
    app.set_theme(Some(if dark {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }));
    Ok(())
}

// 表示・編集の ON/OFF 設定(空白文字表示・折り返しなど)の CheckMenuItem。メニュー項目 ID で引く
struct ToggleMenuItems(HashMap<String, CheckMenuItem<tauri::Wry>>);

// 設定の確定時にフロントエンド(toggles.js)から呼ばれる(起動時の保存値復元も含む)
#[tauri::command]
fn set_toggle(items: tauri::State<ToggleMenuItems>, id: String, on: bool) -> Result<(), String> {
    let item = items
        .0
        .get(&id)
        .ok_or_else(|| format!("未知の設定: {id}"))?;
    item.set_checked(on).map_err(|e| e.to_string())
}

// プレビュー内のリンクを既定のブラウザで開く。開いてよいのは http / https / mailto だけ
fn is_openable_url(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !is_openable_url(&url) {
        return Err(format!("開けない URL です: {url}"));
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("ブラウザを開けませんでした: {e}"))
}

// Finder で表示できるのは実在する絶対パスだけ(`open -R` へのフラグ注入も絶対パス強制で防ぐ)
fn validate_reveal_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err(format!("絶対パスではありません: {path}"));
    }
    if !p.exists() {
        return Err(format!("ファイルが見つかりません: {path}"));
    }
    Ok(())
}

// 「ファイル > Finder で表示」・タブ右クリック: ファイルを Finder で選択した状態で表示する
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    validate_reveal_path(&path)?;
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Finder を開けませんでした: {e}"))
}

// 「編集 > インデント」の CheckMenuItem ハンドル(タブ幅 2 / 4 / 8 とソフトタブ。チェック状態の同期用)
struct IndentMenuItems {
    sizes: Vec<(u32, CheckMenuItem<tauri::Wry>)>,
    soft: CheckMenuItem<tauri::Wry>,
}

// アクティブタブが変わったとき・設定を変えたときにフロントエンドから呼ばれる
#[tauri::command]
fn set_indent(
    items: tauri::State<IndentMenuItems>,
    tab_size: u32,
    soft_tabs: bool,
) -> Result<(), String> {
    for (size, item) in &items.sizes {
        item.set_checked(*size == tab_size)
            .map_err(|e| e.to_string())?;
    }
    items.soft.set_checked(soft_tabs).map_err(|e| e.to_string())
}

// ステータスバーの文字コード・改行コードをクリックしたときのポップアップメニュー。
// 項目 ID はメニューバーの「編集 > 文字コードを変換 / 改行コードを変換」と同じなので、選択は同じ menu イベントで届く。
// current に一致する項目にチェックを付ける(改行コードが混在なら空文字でどれにも付かない)
#[tauri::command]
fn popup_status_menu(
    app: tauri::AppHandle,
    window: tauri::Window,
    kind: String,
    current: String,
) -> Result<(), String> {
    let err = |e: tauri::Error| e.to_string();
    let (prefix, values): (&str, &[&str]) = match kind.as_str() {
        "encoding" => ("set_enc:", &dialog::ENCODINGS[..]),
        "eol" => ("convert_eol:", &dialog::LINE_ENDINGS[..]),
        _ => return Err(format!("未知のメニュー: {kind}")),
    };
    let mut items = Vec::new();
    for v in values {
        items.push(
            CheckMenuItemBuilder::with_id(format!("{prefix}{v}"), *v)
                .checked(*v == current)
                .build(&app)
                .map_err(err)?,
        );
    }
    let mut builder = MenuBuilder::new(&app);
    for item in &items {
        builder = builder.item(item);
    }
    builder.build().map_err(err)?.popup(window).map_err(err)
}

// 「ファイル > 最近使ったファイルを開く」のサブメニュー(項目はフロントエンドの履歴から都度作り直す)
struct RecentMenu(Submenu<tauri::Wry>);

// メニュー表示用にホームディレクトリを ~ に置き換える
fn display_path(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&home) => {
            format!("~{}", &path[home.len()..])
        }
        _ => path.to_string(),
    }
}

// 履歴が変わったときにフロントエンドから呼ばれる。項目 ID は "recent:<index>"(index は paths の並び)
#[tauri::command]
fn set_recent_files(
    app: tauri::AppHandle,
    menu: tauri::State<RecentMenu>,
    paths: Vec<String>,
) -> Result<(), String> {
    let sub = &menu.0;
    let err = |e: tauri::Error| e.to_string();
    while sub.remove_at(0).map_err(err)?.is_some() {}
    if paths.is_empty() {
        let none = MenuItemBuilder::with_id("recent_none", "(なし)")
            .enabled(false)
            .build(&app)
            .map_err(err)?;
        return sub.append(&none).map_err(err);
    }
    for (i, path) in paths.iter().enumerate() {
        let item = MenuItemBuilder::with_id(format!("recent:{i}"), display_path(path))
            .build(&app)
            .map_err(err)?;
        sub.append(&item).map_err(err)?;
    }
    sub.append(&PredefinedMenuItem::separator(&app).map_err(err)?)
        .map_err(err)?;
    let clear = MenuItemBuilder::with_id("recent_clear", "履歴を消去")
        .build(&app)
        .map_err(err)?;
    sub.append(&clear).map_err(err)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Finder から起動と同時に渡されるファイルの受け口。起動時の RunEvent::Opened は
        // setup より前に届くので、setup 内の manage ではなくここで登録する(open_files.rs 参照)
        .manage(open_files::OpenFilesState::default())
        .setup(|app| {
            let about = AboutMetadataBuilder::new().name(Some("mymemo")).build();

            // 起動時のセッション復元の ON/OFF。checked は既定値で、起動直後に set_toggle で保存値に同期される
            let restore_session_item =
                CheckMenuItemBuilder::with_id("toggle_restore_session", "起動時に前回のタブを復元")
                    .checked(true)
                    .build(app)?;

            let app_menu = SubmenuBuilder::new(app, "mymemo")
                .item(&PredefinedMenuItem::about(
                    app,
                    Some("mymemo について"),
                    Some(about),
                )?)
                .separator()
                .item(&restore_session_item)
                .separator()
                .item(&PredefinedMenuItem::hide(app, Some("mymemo を隠す"))?)
                .item(&PredefinedMenuItem::hide_others(app, Some("ほかを隠す"))?)
                .item(&PredefinedMenuItem::show_all(app, Some("すべてを表示"))?)
                .separator()
                // PredefinedMenuItem::quit は即終了でフロントの未保存確認を通らないため、
                // カスタム ID にして menu イベント経由で確認後に quit_app を呼ばせる
                .item(
                    &MenuItemBuilder::with_id("quit", "mymemo を終了")
                        .accelerator("CmdOrCtrl+Q")
                        .build(app)?,
                )
                .build()?;

            // 起動直後にフロントエンドの set_recent_files で保存済みの履歴に置き換わる
            let recent_menu = SubmenuBuilder::new(app, "最近使ったファイルを開く")
                .item(
                    &MenuItemBuilder::with_id("recent_none", "(なし)")
                        .enabled(false)
                        .build(app)?,
                )
                .build()?;
            app.manage(RecentMenu(recent_menu.clone()));

            let file_menu = SubmenuBuilder::new(app, "ファイル")
                .item(
                    &MenuItemBuilder::with_id("new", "新規タブ")
                        .accelerator("CmdOrCtrl+N")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("open", "開く…")
                        .accelerator("CmdOrCtrl+O")
                        .build(app)?,
                )
                .item(&{
                    let mut enc_menu = SubmenuBuilder::new(app, "文字コードを指定して開く");
                    for enc in ["UTF-8", "CP932", "EUC-JP", "UTF-16LE", "UTF-16BE"] {
                        enc_menu = enc_menu.item(
                            &MenuItemBuilder::with_id(format!("open_enc:{enc}"), enc).build(app)?,
                        );
                    }
                    enc_menu.build()?
                })
                .item(&recent_menu)
                .separator()
                .item(
                    &MenuItemBuilder::with_id("save", "保存")
                        .accelerator("CmdOrCtrl+S")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("save_as", "名前を付けて保存…")
                        .accelerator("CmdOrCtrl+Shift+S")
                        .build(app)?,
                )
                .item(&MenuItemBuilder::with_id("revert", "保存済みの状態に戻す").build(app)?)
                .separator()
                // アクティブタブが対象。無題タブでは何もしない(フロント側で no-op)
                .item(&MenuItemBuilder::with_id("reveal_in_finder", "Finder で表示").build(app)?)
                .item(&MenuItemBuilder::with_id("copy_path", "パスをコピー").build(app)?)
                .separator()
                .item(
                    &MenuItemBuilder::with_id("close_tab", "タブを閉じる")
                        .accelerator("CmdOrCtrl+W")
                        .build(app)?,
                )
                .build()?;

            // ON/OFF 設定の項目。checked は既定値で、起動直後にフロントエンドの set_toggle で保存値に同期される
            let mut toggles = HashMap::new();
            let mut toggle_item = |id: &str, label: &str, default: bool| {
                let item = CheckMenuItemBuilder::with_id(id, label)
                    .checked(default)
                    .build(app)?;
                toggles.insert(id.to_string(), item.clone());
                tauri::Result::Ok(item)
            };
            let close_brackets_item =
                toggle_item("toggle_close_brackets", "括弧・引用符を自動で閉じる", false)?;
            let word_completion_item =
                toggle_item("toggle_word_completion", "単語を補完する", false)?;

            // 既定はタブ幅 4・ハードタブ。アクティブタブに合わせてフロントエンドの set_indent で同期される
            let mut size_items = Vec::new();
            let mut indent_sub = SubmenuBuilder::new(app, "インデント");
            for size in [2u32, 4, 8] {
                let item = CheckMenuItemBuilder::with_id(
                    format!("tabsize:{size}"),
                    format!("タブ幅 {size}"),
                )
                .checked(size == 4)
                .build(app)?;
                indent_sub = indent_sub.item(&item);
                size_items.push((size, item));
            }
            let soft_item =
                CheckMenuItemBuilder::with_id("soft_tabs", "スペースでインデント(ソフトタブ)")
                    .checked(false)
                    .build(app)?;
            let indent_menu = indent_sub.separator().item(&soft_item).build()?;
            app.manage(IndentMenuItems {
                sizes: size_items,
                soft: soft_item,
            });

            let edit_menu = SubmenuBuilder::new(app, "編集")
                .item(&PredefinedMenuItem::undo(app, Some("取り消す"))?)
                .item(&PredefinedMenuItem::redo(app, Some("やり直す"))?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, Some("カット"))?)
                .item(&PredefinedMenuItem::copy(app, Some("コピー"))?)
                .item(&PredefinedMenuItem::paste(app, Some("ペースト"))?)
                .item(&PredefinedMenuItem::select_all(app, Some("すべてを選択"))?)
                .separator()
                .item(&{
                    // 全行の改行コードを統一する(保存はしない)。フロントで setAllLineEndings を適用する
                    let mut eol_menu = SubmenuBuilder::new(app, "改行コードを変換");
                    for eol in dialog::LINE_ENDINGS {
                        eol_menu = eol_menu.item(
                            &MenuItemBuilder::with_id(format!("convert_eol:{eol}"), eol)
                                .build(app)?,
                        );
                    }
                    eol_menu.build()?
                })
                .item(&{
                    // 保存時の文字コードを変える(本文は変えない)。フロントで Tabs.setEncoding を適用する
                    let mut enc_menu = SubmenuBuilder::new(app, "文字コードを変換");
                    for enc in dialog::ENCODINGS {
                        enc_menu = enc_menu.item(
                            &MenuItemBuilder::with_id(format!("set_enc:{enc}"), enc).build(app)?,
                        );
                    }
                    enc_menu.build()?
                })
                .item(&indent_menu)
                .item(&close_brackets_item)
                .item(&word_completion_item)
                .separator()
                .item(&{
                    // 行単位の変換。フロントの transform.js が選択範囲(無ければ全文)に適用する
                    let mut sub = SubmenuBuilder::new(app, "テキスト変換");
                    for (id, label) in [
                        ("transform:sort_asc", "行を昇順にソート"),
                        ("transform:sort_desc", "行を降順にソート"),
                        ("transform:unique", "重複する行を削除"),
                        ("transform:remove_blank", "空行を削除"),
                    ] {
                        sub = sub.item(&MenuItemBuilder::with_id(id, label).build(app)?);
                    }
                    sub.build()?
                })
                .item(&{
                    // Markdown の書式。選択範囲をマーカーで囲む / 外す(フロントの markdown.js)
                    let mut sub = SubmenuBuilder::new(app, "Markdown");
                    for (id, label, key) in [
                        ("md:bold", "太字", "CmdOrCtrl+B"),
                        ("md:italic", "斜体", "CmdOrCtrl+I"),
                        ("md:strike", "取り消し線", "CmdOrCtrl+Shift+X"),
                        ("md:code", "インラインコード", "CmdOrCtrl+E"),
                        ("md:link", "リンク", "CmdOrCtrl+K"),
                    ] {
                        sub = sub.item(
                            &MenuItemBuilder::with_id(id, label)
                                .accelerator(key)
                                .build(app)?,
                        );
                    }
                    sub = sub.separator();
                    for level in 1..=6u8 {
                        sub = sub.item(
                            &MenuItemBuilder::with_id(
                                format!("md:heading:{level}"),
                                format!("見出し {level}"),
                            )
                            .accelerator(format!("CmdOrCtrl+Alt+{level}"))
                            .build(app)?,
                        );
                    }
                    sub = sub.item(
                        &MenuItemBuilder::with_id("md:heading:0", "見出しを解除")
                            .accelerator("CmdOrCtrl+Alt+0")
                            .build(app)?,
                    );
                    sub = sub.separator();
                    for (id, label, key) in [
                        ("md:bullet", "箇条書き", "CmdOrCtrl+Shift+8"),
                        ("md:ordered", "番号付きリスト", "CmdOrCtrl+Shift+7"),
                        ("md:quote", "引用", "CmdOrCtrl+Shift+."),
                        (
                            "md:checkbox",
                            "チェックボックスの切替",
                            "CmdOrCtrl+Shift+Enter",
                        ),
                    ] {
                        sub = sub.item(
                            &MenuItemBuilder::with_id(id, label)
                                .accelerator(key)
                                .build(app)?,
                        );
                    }
                    sub = sub.item(
                        &MenuItemBuilder::with_id("md:renumber", "番号を振り直す").build(app)?,
                    );
                    sub.build()?
                })
                .build()?;

            let search_menu = SubmenuBuilder::new(app, "検索")
                .item(
                    &MenuItemBuilder::with_id("find", "検索・置換…")
                        .accelerator("CmdOrCtrl+F")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("grep", "フォルダ内を検索 (grep)…")
                        .accelerator("CmdOrCtrl+Shift+F")
                        .build(app)?,
                )
                .separator()
                .item(
                    &MenuItemBuilder::with_id("goto_line", "行へ移動…")
                        .accelerator("CmdOrCtrl+L")
                        .build(app)?,
                )
                .build()?;

            let theme_defs = [
                ("theme:dark", "ダーク"),
                ("theme:light", "ライト"),
                ("theme:solarized-dark", "Solarized ダーク"),
                ("theme:solarized-light", "Solarized ライト"),
            ];
            let mut theme_items = Vec::new();
            for (id, label) in theme_defs {
                theme_items.push(
                    CheckMenuItemBuilder::with_id(id, label)
                        // 既定はダーク。起動直後にフロントエンドの set_theme で保存値に同期される
                        .checked(id == "theme:dark")
                        .build(app)?,
                );
            }
            let mut theme_sub = SubmenuBuilder::new(app, "テーマ");
            for item in &theme_items {
                theme_sub = theme_sub.item(item);
            }
            let whitespace_item = toggle_item("toggle_whitespace", "空白文字・改行を表示", true)?;
            let wrap_item = toggle_item("toggle_wrap", "行を折り返す", false)?;
            let fold_gutter_item =
                toggle_item("toggle_fold_gutter", "折りたたみガターを表示", true)?;
            // Markdown プレビュー(既定は非表示)。アクセラレータ付きなので toggle_item を使わず直接作る
            let preview_item =
                CheckMenuItemBuilder::with_id("toggle_preview", "Markdown プレビュー")
                    .checked(false)
                    .accelerator("CmdOrCtrl+Shift+P")
                    .build(app)?;
            toggles.insert("toggle_preview".to_string(), preview_item.clone());
            // アプリメニューの項目もチェック同期の対象にする(作成はメニュー構築順の都合で上の方)
            toggles.insert(
                "toggle_restore_session".to_string(),
                restore_session_item.clone(),
            );
            // 折りたたみのキーは CodeMirror の foldKeymap と同じ。言語が判定できたファイルでだけ効く
            let fold_menu = SubmenuBuilder::new(app, "折りたたみ")
                .item(
                    &MenuItemBuilder::with_id("fold_code", "折りたたむ")
                        .accelerator("CmdOrCtrl+Alt+[")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("unfold_code", "展開")
                        .accelerator("CmdOrCtrl+Alt+]")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("fold_all", "すべて折りたたむ")
                        .accelerator("Ctrl+Alt+[")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("unfold_all", "すべて展開")
                        .accelerator("Ctrl+Alt+]")
                        .build(app)?,
                )
                .separator()
                .item(&fold_gutter_item)
                .build()?;
            let view_menu = SubmenuBuilder::new(app, "表示")
                .item(&theme_sub.build()?)
                .separator()
                .item(&whitespace_item)
                .item(&wrap_item)
                .item(&fold_menu)
                .separator()
                .item(&preview_item)
                .separator()
                .item(
                    &MenuItemBuilder::with_id("zoom_in", "拡大")
                        .accelerator("CmdOrCtrl+=")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("zoom_out", "縮小")
                        .accelerator("CmdOrCtrl+-")
                        .build(app)?,
                )
                .item(
                    &MenuItemBuilder::with_id("zoom_reset", "標準サイズ")
                        .accelerator("CmdOrCtrl+0")
                        .build(app)?,
                )
                .build()?;
            app.manage(ThemeMenuItems(theme_items));
            app.manage(ToggleMenuItems(toggles));

            let window_menu = SubmenuBuilder::new(app, "ウインドウ")
                .item(&PredefinedMenuItem::minimize(app, Some("しまう"))?)
                .item(&PredefinedMenuItem::fullscreen(
                    app,
                    Some("フルスクリーン"),
                )?)
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[
                    &app_menu,
                    &file_menu,
                    &edit_menu,
                    &search_menu,
                    &view_menu,
                    &window_menu,
                ])
                .build()?;
            app.set_menu(menu)?;

            app.on_menu_event(|app, event| {
                // カスタム項目はフロントエンドへ通知して処理する
                let _ = app.emit("menu", event.id().0.clone());
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            quit_app,
            set_theme,
            set_toggle,
            set_recent_files,
            set_indent,
            popup_status_menu,
            open_url,
            reveal_in_finder,
            open_files::take_pending_open_files,
            grep::grep_search,
            grep::grep_replace,
            file_io::read_file,
            file_io::write_file,
            file_io::file_mtime,
            dialog::save_dialog_with_options
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Finder の「このアプリケーションで開く」・ダブルクリック・Dock へのドロップ。
            // macOS は argv ではなく Apple Event でファイルを渡すのでここで受ける
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => open_files::handle_opened(app, urls),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::display_path;

    #[test]
    fn open_url_は_http_https_mailto_だけ許す() {
        use super::is_openable_url;
        assert!(is_openable_url("https://example.com/a?b=c"));
        assert!(is_openable_url("http://localhost:1420/"));
        assert!(is_openable_url("mailto:a@b.c"));
        assert!(!is_openable_url("file:///etc/passwd"));
        assert!(!is_openable_url("javascript:alert(1)"));
        assert!(!is_openable_url("/usr/bin/env"));
        assert!(!is_openable_url("-R"));
    }

    #[test]
    fn validate_reveal_path_は実在する絶対パスだけ許す() {
        use super::validate_reveal_path;
        let f = tempfile::NamedTempFile::new().unwrap();
        assert!(validate_reveal_path(f.path().to_str().unwrap()).is_ok());
        assert!(validate_reveal_path("relative/a.txt").is_err());
        assert!(validate_reveal_path("-R").is_err());
        assert!(validate_reveal_path("/no/such/file/exists.txt").is_err());
    }

    #[test]
    fn display_path_はホームを_チルダに置き換える() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            display_path(&format!("{home}/notes/a.txt")),
            "~/notes/a.txt"
        );
        assert_eq!(display_path("/tmp/a.txt"), "/tmp/a.txt");
    }
}
