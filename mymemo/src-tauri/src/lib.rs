mod dialog;
mod file_io;
mod grep;

use tauri::menu::{
    AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder,
    PredefinedMenuItem, SubmenuBuilder,
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
                .separator()
                .item(
                    &MenuItemBuilder::with_id("close_tab", "タブを閉じる")
                        .accelerator("CmdOrCtrl+W")
                        .build(app)?,
                )
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "編集")
                .item(&PredefinedMenuItem::undo(app, Some("取り消す"))?)
                .item(&PredefinedMenuItem::redo(app, Some("やり直す"))?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, Some("カット"))?)
                .item(&PredefinedMenuItem::copy(app, Some("コピー"))?)
                .item(&PredefinedMenuItem::paste(app, Some("ペースト"))?)
                .item(&PredefinedMenuItem::select_all(app, Some("すべてを選択"))?)
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
            let view_menu = SubmenuBuilder::new(app, "表示")
                .item(&theme_sub.build()?)
                .build()?;
            app.manage(ThemeMenuItems(theme_items));

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
            grep::grep_search,
            file_io::read_file,
            file_io::write_file,
            dialog::save_dialog_with_options
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
