use encoding_rs::{Encoding, EUC_JP, SHIFT_JIS, UTF_8};
use serde::Serialize;
use std::fs;

#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
    pub line_ending: String,
    pub lossy: bool,
}

fn encoding_for(name: &str) -> Result<&'static Encoding, String> {
    match name {
        "CP932" => Ok(SHIFT_JIS),
        other => {
            Encoding::for_label(other.as_bytes()).ok_or_else(|| format!("未対応の文字コード: {other}"))
        }
    }
}

fn display_name(enc: &'static Encoding) -> String {
    match enc.name() {
        "Shift_JIS" => "CP932".to_string(),
        name => name.to_string(),
    }
}

fn detect_line_ending(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "CRLF"
    } else if text.contains('\r') {
        "CR"
    } else {
        "LF"
    }
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

// encoding を省略した場合は BOM → UTF-8 → CP932 → EUC-JP の順で自動判定する
#[tauri::command]
pub fn read_file(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| format!("読み込みエラー: {e}"))?;

    let (text, enc, lossy) = if let Some(name) = encoding {
        let enc = encoding_for(&name)?;
        let (text, _, had_errors) = enc.decode(&bytes);
        (text.into_owned(), enc, had_errors)
    } else if let Some((enc, _bom_len)) = Encoding::for_bom(&bytes) {
        let (text, _, had_errors) = enc.decode(&bytes);
        (text.into_owned(), enc, had_errors)
    } else if let Ok(text) = String::from_utf8(bytes.clone()) {
        (text, UTF_8, false)
    } else {
        let (sjis_text, _, sjis_err) = SHIFT_JIS.decode(&bytes);
        if !sjis_err {
            (sjis_text.into_owned(), SHIFT_JIS, false)
        } else {
            let (euc_text, _, euc_err) = EUC_JP.decode(&bytes);
            if !euc_err {
                (euc_text.into_owned(), EUC_JP, false)
            } else {
                let (text, _, _) = UTF_8.decode(&bytes);
                (text.into_owned(), UTF_8, true)
            }
        }
    };

    let line_ending = detect_line_ending(&text);
    Ok(FileContent {
        content: normalize_newlines(&text),
        encoding: display_name(enc),
        line_ending: line_ending.to_string(),
        lossy,
    })
}

#[tauri::command]
pub fn write_file(
    path: String,
    content: String,
    encoding: String,
    line_ending: String,
) -> Result<(), String> {
    let text = match line_ending.as_str() {
        "CRLF" => content.replace('\n', "\r\n"),
        "CR" => content.replace('\n', "\r"),
        _ => content,
    };
    let enc = encoding_for(&encoding)?;
    let bytes: Vec<u8> = if enc.name().starts_with("UTF-16") {
        // encoding_rs は UTF-16 エンコード非対応のため手動で変換(BOM 付き)
        let le = enc.name() == "UTF-16LE";
        let mut out = if le {
            vec![0xFF, 0xFE]
        } else {
            vec![0xFE, 0xFF]
        };
        for u in text.encode_utf16() {
            let b = if le { u.to_le_bytes() } else { u.to_be_bytes() };
            out.extend_from_slice(&b);
        }
        out
    } else {
        let (bytes, _, had_errors) = enc.encode(&text);
        if had_errors {
            return Err(format!(
                "{encoding} で表現できない文字が含まれています"
            ));
        }
        bytes.into_owned()
    };
    fs::write(&path, bytes).map_err(|e| format!("保存エラー: {e}"))
}
