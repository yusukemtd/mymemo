mod dialog;
mod file_io;
mod grep;
mod open_files;

use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder,
    PredefinedMenuItem, Submenu, SubmenuBuilder,
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

// 「表示 > 空白文字・改行を表示」の CheckMenuItem ハンドル(チェック状態の同期用)
struct WhitespaceMenuItem(CheckMenuItem<tauri::Wry>);

// 表示切替の確定時にフロントエンドから呼ばれる(起動時の保存値復元も含む)
#[tauri::command]
fn set_show_whitespace(
    item: tauri::State<WhitespaceMenuItem>,
    show: bool,
) -> Result<(), String> {
    item.0.set_checked(show).map_err(|e| e.to_string())
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
        item.set_checked(*size == tab_size).map_err(|e| e.to_string())?;
    }
    items.soft.set_checked(soft_tabs).map_err(|e| e.to_string())
}

// 「表示 > 行を折り返す」の CheckMenuItem ハンドル(チェック状態の同期用)
struct WrapMenuItem(CheckMenuItem<tauri::Wry>);

// 折り返し切替の確定時にフロントエンドから呼ばれる(起動時の保存値復元も含む)
#[tauri::command]
fn set_line_wrap(item: tauri::State<WrapMenuItem>, wrap: bool) -> Result<(), String> {
    item.0.set_checked(wrap).map_err(|e| e.to_string())
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
            let about = AboutMetadataBuilder::new()
                .name(Some("mymemo"))
                .build();

            let app_menu = SubmenuBuilder::new(app, "mymemo")
                .item(&PredefinedMenuItem::about(
                    app,
                    Some("mymemo について"),
                    Some(about),
                )?)
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
                            &MenuItemBuilder::with_id(format!("open_enc:{enc}"), enc)
                                .build(app)?,
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
                .item(
                    &MenuItemBuilder::with_id("close_tab", "タブを閉じる")
                        .accelerator("CmdOrCtrl+W")
                        .build(app)?,
                )
                .build()?;

            // 既定はタブ幅 4・ハードタブ。アクティブタブに合わせてフロントエンドの set_indent で同期される
            let mut size_items = Vec::new();
            let mut indent_sub = SubmenuBuilder::new(app, "インデント");
            for size in [2u32, 4, 8] {
                let item = CheckMenuItemBuilder::with_id(format!("tabsize:{size}"), format!("タブ幅 {size}"))
                    .checked(size == 4)
                    .build(app)?;
                indent_sub = indent_sub.item(&item);
                size_items.push((size, item));
            }
            let soft_item = CheckMenuItemBuilder::with_id("soft_tabs", "スペースでインデント(ソフトタブ)")
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
                .item(&indent_menu)
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
            // 既定は表示。起動直後にフロントエンドの set_show_whitespace で保存値に同期される
            let whitespace_item =
                CheckMenuItemBuilder::with_id("toggle_whitespace", "空白文字・改行を表示")
                    .checked(true)
                    .build(app)?;
            // 既定は折り返さない。起動直後にフロントエンドの set_line_wrap で保存値に同期される
            let wrap_item = CheckMenuItemBuilder::with_id("toggle_wrap", "行を折り返す")
                .checked(false)
                .build(app)?;
            let view_menu = SubmenuBuilder::new(app, "表示")
                .item(&theme_sub.build()?)
                .separator()
                .item(&whitespace_item)
                .item(&wrap_item)
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
            app.manage(WhitespaceMenuItem(whitespace_item));
            app.manage(WrapMenuItem(wrap_item));

            let window_menu = SubmenuBuilder::new(app, "ウインドウ")
                .item(&PredefinedMenuItem::minimize(app, Some("しまう"))?)
                .item(&PredefinedMenuItem::fullscreen(app, Some("フルスクリーン"))?)
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
            set_show_whitespace,
            set_line_wrap,
            set_recent_files,
            set_indent,
            open_files::take_pending_open_files,
            grep::grep_search,
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
    fn display_path_はホームを_チルダに置き換える() {
        let home = std::env::var("HOME").unwrap();
        assert_eq!(display_path(&format!("{home}/notes/a.txt")), "~/notes/a.txt");
        assert_eq!(display_path("/tmp/a.txt"), "/tmp/a.txt");
    }
}
