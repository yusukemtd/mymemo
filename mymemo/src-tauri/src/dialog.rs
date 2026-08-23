// NSSavePanel にアクセサリビューを付けて文字コード・改行コードを選ばせる。
// tauri-plugin-dialog(rfd)はアクセサリビュー非対応のため AppKit を直接使う。
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSPopUpButton, NSSavePanel, NSTextField, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use serde::Serialize;

const ENCODINGS: [&str; 5] = ["UTF-8", "CP932", "EUC-JP", "UTF-16LE", "UTF-16BE"];
const LINE_ENDINGS: [&str; 3] = ["LF", "CRLF", "CR"];

#[derive(Serialize)]
pub struct SaveChoice {
    pub path: String,
    pub encoding: String,
    pub line_ending: String,
}

fn make_popup(
    mtm: MainThreadMarker,
    x: f64,
    y: f64,
    items: &[&str],
    selected: &str,
) -> Retained<NSPopUpButton> {
    let popup = NSPopUpButton::initWithFrame_pullsDown(
        mtm.alloc(),
        NSRect::new(NSPoint::new(x, y), NSSize::new(160.0, 26.0)),
        false,
    );
    for item in items {
        popup.addItemWithTitle(&NSString::from_str(item));
    }
    popup.selectItemWithTitle(&NSString::from_str(selected));
    popup
}

fn make_label(mtm: MainThreadMarker, text: &str, x: f64, y: f64) -> Retained<NSTextField> {
    let label = NSTextField::labelWithString(&NSString::from_str(text), mtm);
    label.setFrame(NSRect::new(NSPoint::new(x, y), NSSize::new(100.0, 20.0)));
    label
}

fn run_panel(default_name: &str, encoding: &str, line_ending: &str) -> Option<SaveChoice> {
    let mtm = MainThreadMarker::new()?;
    let panel = NSSavePanel::savePanel(mtm);
    panel.setNameFieldStringValue(&NSString::from_str(default_name));
    panel.setCanCreateDirectories(true);

    let view = NSView::initWithFrame(
        mtm.alloc(),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(300.0, 74.0)),
    );
    let enc_label = make_label(mtm, "文字コード:", 0.0, 44.0);
    let enc_popup = make_popup(mtm, 100.0, 40.0, &ENCODINGS, encoding);
    let eol_label = make_label(mtm, "改行コード:", 0.0, 12.0);
    let eol_popup = make_popup(mtm, 100.0, 8.0, &LINE_ENDINGS, line_ending);
    view.addSubview(&enc_label);
    view.addSubview(&enc_popup);
    view.addSubview(&eol_label);
    view.addSubview(&eol_popup);
    panel.setAccessoryView(Some(&view));

    // NSModalResponseOK == 1
    if panel.runModal() != 1 {
        return None;
    }
    let path = panel.URL()?.path()?.to_string();
    Some(SaveChoice {
        path,
        encoding: enc_popup
            .titleOfSelectedItem()
            .map(|s| s.to_string())
            .unwrap_or_else(|| encoding.to_string()),
        line_ending: eol_popup
            .titleOfSelectedItem()
            .map(|s| s.to_string())
            .unwrap_or_else(|| line_ending.to_string()),
    })
}

#[tauri::command]
pub async fn save_dialog_with_options(
    app: tauri::AppHandle,
    default_name: String,
    encoding: String,
    line_ending: String,
) -> Result<Option<SaveChoice>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(run_panel(&default_name, &encoding, &line_ending));
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}
