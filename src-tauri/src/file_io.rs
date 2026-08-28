use encoding_rs::{Encoding, EUC_JP, SHIFT_JIS, UTF_8};
use serde::Serialize;
use std::fs;

// content は改行コードを正規化しない生テキスト。改行コード(行ごとの LF/CR/CRLF)は
// フロントエンド側で分離・保持し、保存時も復元済みのテキストを受け取ってそのまま書く
#[derive(Serialize)]
pub struct FileContent {
    pub content: String,
    pub encoding: String,
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

// BOM → UTF-8 → CP932 → EUC-JP の順で自動判定してデコードする。
// どれでも正しく読めない場合は UTF-8 の lossy デコードにして lossy = true を返す。
// grep 側も同じ判定を使うことで、検索結果とエディタで開いたときの解釈が一致する
pub(crate) fn decode_auto(bytes: Vec<u8>) -> (String, &'static Encoding, bool) {
    if let Some((enc, _bom_len)) = Encoding::for_bom(&bytes) {
        let (text, _, had_errors) = enc.decode(&bytes);
        return (text.into_owned(), enc, had_errors);
    }
    match String::from_utf8(bytes) {
        Ok(text) => (text, UTF_8, false),
        Err(e) => {
            let bytes = e.into_bytes();
            let (sjis_text, _, sjis_err) = SHIFT_JIS.decode(&bytes);
            if !sjis_err {
                return (sjis_text.into_owned(), SHIFT_JIS, false);
            }
            let (euc_text, _, euc_err) = EUC_JP.decode(&bytes);
            if !euc_err {
                return (euc_text.into_owned(), EUC_JP, false);
            }
            let (text, _, _) = UTF_8.decode(&bytes);
            (text.into_owned(), UTF_8, true)
        }
    }
}

// 同期コマンドはメインスレッドで実行され、巨大ファイルで UI が固まるため
// blocking スレッドへ逃がす(write_file も同様)
#[tauri::command]
pub async fn read_file(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_impl(path, encoding))
        .await
        .map_err(|e| format!("読み込みスレッドエラー: {e}"))?
}

// encoding を省略した場合は BOM → UTF-8 → CP932 → EUC-JP の順で自動判定する
fn read_file_impl(path: String, encoding: Option<String>) -> Result<FileContent, String> {
    let bytes = fs::read(&path).map_err(|e| format!("読み込みエラー: {e}"))?;

    let (text, enc, lossy) = if let Some(name) = encoding {
        let enc = encoding_for(&name)?;
        let (text, _, had_errors) = enc.decode(&bytes);
        (text.into_owned(), enc, had_errors)
    } else {
        decode_auto(bytes)
    };

    Ok(FileContent {
        content: text,
        encoding: display_name(enc),
        lossy,
    })
}

// content は改行コードを含めて完成したテキスト(変換しない)
#[tauri::command]
pub async fn write_file(path: String, content: String, encoding: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_file_impl(path, content, encoding))
        .await
        .map_err(|e| format!("保存スレッドエラー: {e}"))?
}

fn write_file_impl(path: String, text: String, encoding: String) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_bytes(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> String {
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn read_utf8_without_bom() {
        let dir = tempdir().unwrap();
        let path = write_bytes(&dir, "a.txt", "こんにちは\n".as_bytes());
        let r = read_file_impl(path, None).unwrap();
        assert_eq!(r.content, "こんにちは\n");
        assert_eq!(r.encoding, "UTF-8");
        assert!(!r.lossy);
    }

    #[test]
    fn read_utf8_with_bom_strips_bom() {
        let dir = tempdir().unwrap();
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("abc".as_bytes());
        let path = write_bytes(&dir, "bom.txt", &bytes);
        let r = read_file_impl(path, None).unwrap();
        assert_eq!(r.content, "abc");
        assert_eq!(r.encoding, "UTF-8");
    }

    #[test]
    fn read_auto_detects_cp932() {
        let dir = tempdir().unwrap();
        let (bytes, _, _) = SHIFT_JIS.encode("日本語テキスト");
        let path = write_bytes(&dir, "sjis.txt", &bytes);
        let r = read_file_impl(path, None).unwrap();
        assert_eq!(r.content, "日本語テキスト");
        assert_eq!(r.encoding, "CP932");
    }

    #[test]
    fn read_with_explicit_euc_jp() {
        let dir = tempdir().unwrap();
        let (bytes, _, _) = EUC_JP.encode("日本語");
        let path = write_bytes(&dir, "euc.txt", &bytes);
        let r = read_file_impl(path, Some("EUC-JP".to_string())).unwrap();
        assert_eq!(r.content, "日本語");
        assert_eq!(r.encoding, "EUC-JP");
    }

    #[test]
    fn read_unknown_encoding_is_error() {
        let dir = tempdir().unwrap();
        let path = write_bytes(&dir, "x.txt", b"abc");
        assert!(read_file_impl(path, Some("NO-SUCH-ENC".to_string())).is_err());
    }

    #[test]
    fn read_keeps_mixed_line_endings_verbatim() {
        let dir = tempdir().unwrap();
        let path = write_bytes(&dir, "mixed.txt", b"a\r\nb\rc\nd");
        let r = read_file_impl(path, None).unwrap();
        assert_eq!(r.content, "a\r\nb\rc\nd");
    }

    #[test]
    fn write_keeps_line_endings_verbatim() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.txt").to_string_lossy().into_owned();
        write_file_impl(path.clone(), "a\r\nb\rc\n".into(), "UTF-8".into()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\rc\n");
    }

    #[test]
    fn write_cp932_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.txt").to_string_lossy().into_owned();
        write_file_impl(path.clone(), "日本語".into(), "CP932".into()).unwrap();
        let r = read_file_impl(path, Some("CP932".to_string())).unwrap();
        assert_eq!(r.content, "日本語");
    }

    #[test]
    fn write_utf16le_has_bom_and_round_trips() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.txt").to_string_lossy().into_owned();
        write_file_impl(path.clone(), "あA".into(), "UTF-16LE".into()).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]);
        let r = read_file_impl(path, None).unwrap(); // BOM から自動判定される
        assert_eq!(r.content, "あA");
    }

    #[test]
    fn write_unencodable_char_is_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("out.txt").to_string_lossy().into_owned();
        let err = write_file_impl(path.clone(), "🍣".into(), "CP932".into());
        assert!(err.is_err());
        assert!(!dir.path().join("out.txt").exists()); // エラー時はファイルを作らない
    }
}
