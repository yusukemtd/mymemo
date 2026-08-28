use crate::file_io::decode_auto;
use encoding_rs::Encoding;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;

const MAX_HITS: usize = 5000;
// エンコーディング自動判定のため全読みするので、これを超えるファイルは検索対象外
const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;

#[derive(Serialize)]
pub struct Hit {
    pub path: String,
    pub line_number: u64,
    pub line_text: String,
}

#[derive(Serialize)]
pub struct GrepResult {
    pub hits: Vec<Hit>,
    pub truncated: bool,
}

// 同期コマンドはメインスレッドで実行され UI が固まるため、blocking スレッドへ逃がす
#[tauri::command]
pub async fn grep_search(
    dir: String,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<GrepResult, String> {
    tauri::async_runtime::spawn_blocking(move || grep_impl(dir, pattern, is_regex, case_sensitive))
        .await
        .map_err(|e| format!("検索スレッドエラー: {e}"))?
}

fn grep_impl(
    dir: String,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
) -> Result<GrepResult, String> {
    let pat = if is_regex {
        pattern
    } else {
        regex_escape(&pattern)
    };
    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .build(&pat)
        .map_err(|e| format!("正規表現エラー: {e}"))?;

    let mut hits = Vec::new();
    let mut truncated = false;

    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build();

    // .gitignore や隠しファイルを尊重して走査する
    for entry in WalkBuilder::new(&dir).build() {
        if truncated {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map_or(false, |t| t.is_file()) {
            continue;
        }
        // エンコーディング自動判定のため全読みが必要なので、巨大ファイルは読む前に除外する
        if entry.metadata().map_or(true, |m| m.len() > MAX_FILE_SIZE) {
            continue;
        }
        let bytes = match fs::read(entry.path()) {
            Ok(b) => b,
            Err(_) => continue, // 読めないファイルはスキップ
        };
        // NUL バイトを含むファイルはバイナリとしてスキップ。
        // ただし BOM 付き(UTF-16 等)は NUL バイトを含むのが正常なので除外しない
        if Encoding::for_bom(&bytes).is_none() && bytes.contains(&0) {
            continue;
        }
        // read_file と同じ自動判定で UTF-8 へ変換してから検索する。これにより
        // CP932 / EUC-JP / UTF-16(BOM 付き)のファイルにも日本語パターンがヒットし、
        // 行番号はデコード後もファイルと一致する(SJIS/EUC の 2 バイト目に 0x0A は現れない)
        let (text, _, _) = decode_auto(bytes);
        let path_str = entry.path().to_string_lossy().to_string();
        let _ = searcher.search_slice(
            &matcher,
            text.as_bytes(),
            Lossy(|line_number, line| {
                if hits.len() >= MAX_HITS {
                    truncated = true;
                    return Ok(false); // 走査打ち切り
                }
                hits.push(Hit {
                    path: path_str.clone(),
                    line_number,
                    line_text: line.chars().take(500).collect(),
                });
                Ok(true)
            }),
        );
    }

    Ok(GrepResult { hits, truncated })
}

fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for c in s.chars() {
        if "\\.+*?()|[]{}^$#&-~".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn setup(files: &[(&str, &[u8])]) -> tempfile::TempDir {
        let dir = tempdir().unwrap();
        for (name, bytes) in files {
            fs::write(dir.path().join(name), bytes).unwrap();
        }
        dir
    }

    fn search(dir: &tempfile::TempDir, pat: &str, is_regex: bool, case: bool) -> GrepResult {
        grep_impl(
            dir.path().to_string_lossy().into_owned(),
            pat.to_string(),
            is_regex,
            case,
        )
        .unwrap()
    }

    #[test]
    fn literal_search_does_not_treat_dot_as_wildcard() {
        let dir = setup(&[("a.txt", b"a.b\naXb\n")]);
        let r = search(&dir, "a.b", false, true);
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].line_number, 1);
        assert!(!r.truncated);
    }

    #[test]
    fn regex_search_matches_pattern() {
        let dir = setup(&[("a.txt", b"foo1\nfoo2\nbar\n")]);
        let r = search(&dir, r"foo\d", true, true);
        assert_eq!(r.hits.len(), 2);
    }

    #[test]
    fn case_insensitive_by_default_flag() {
        let dir = setup(&[("a.txt", b"Hello\nhello\n")]);
        assert_eq!(search(&dir, "hello", false, false).hits.len(), 2);
        assert_eq!(search(&dir, "hello", false, true).hits.len(), 1);
    }

    #[test]
    fn invalid_regex_returns_error() {
        let dir = setup(&[("a.txt", b"x\n")]);
        let err = grep_impl(
            dir.path().to_string_lossy().into_owned(),
            "(".to_string(),
            true,
            true,
        );
        assert!(err.is_err());
    }

    #[test]
    fn non_utf8_files_are_searched() {
        // CP932 のファイルもスキップされず、ASCII パターンでヒットする
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("needle 日本語\nほかの行\n");
        let dir = setup(&[("sjis.txt", &sjis[..]), ("a.txt", b"needle\n")]);
        let r = search(&dir, "needle", false, true);
        assert_eq!(r.hits.len(), 2);
    }

    #[test]
    fn japanese_pattern_matches_non_utf8_files() {
        // デコードしてから検索するため、日本語パターンが CP932 / EUC-JP にもヒットする
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("1行目\nこれは日本語の行\n");
        let (euc, _, _) = encoding_rs::EUC_JP.encode("日本語もヒットする\n");
        let dir = setup(&[
            ("sjis.txt", &sjis[..]),
            ("euc.txt", &euc[..]),
            ("utf8.txt", "UTF-8 の日本語\n".as_bytes()),
        ]);
        let r = search(&dir, "日本語", false, true);
        assert_eq!(r.hits.len(), 3);
        // 行番号はデコード後もファイルと一致する
        let sjis_hit = r.hits.iter().find(|h| h.path.ends_with("sjis.txt")).unwrap();
        assert_eq!(sjis_hit.line_number, 2);
        assert_eq!(sjis_hit.line_text, "これは日本語の行\n");
    }

    #[test]
    fn utf16_bom_files_are_searched() {
        // UTF-16 は NUL バイトを含むが、BOM 付きならバイナリ扱いせず検索する
        let mut bytes = vec![0xFF, 0xFE];
        for u in "needle 日本語\n".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let dir = setup(&[("u16.txt", &bytes[..])]);
        assert_eq!(search(&dir, "日本語", false, true).hits.len(), 1);
        assert_eq!(search(&dir, "needle", false, true).hits.len(), 1);
    }

    #[test]
    fn files_over_size_limit_are_skipped() {
        let mut big = String::from("needle\n");
        big.push_str(&"x".repeat((MAX_FILE_SIZE as usize) + 1024));
        let dir = setup(&[("big.txt", big.as_bytes()), ("small.txt", b"needle\n")]);
        let r = search(&dir, "needle", false, true);
        assert_eq!(r.hits.len(), 1);
        assert!(r.hits[0].path.ends_with("small.txt"));
    }

    #[test]
    fn hidden_files_are_skipped() {
        let dir = setup(&[("a.txt", b"needle\n"), (".secret", b"needle\n")]);
        let r = search(&dir, "needle", false, true);
        assert_eq!(r.hits.len(), 1);
        assert!(r.hits[0].path.ends_with("a.txt"));
    }

    #[test]
    fn binary_files_are_skipped() {
        let dir = setup(&[("bin.dat", b"needle\x00needle\n"), ("a.txt", b"needle\n")]);
        let r = search(&dir, "needle", false, true);
        assert_eq!(r.hits.len(), 1);
        assert!(r.hits[0].path.ends_with("a.txt"));
    }

    #[test]
    fn long_lines_are_clamped_to_500_chars() {
        let long = format!("needle{}\n", "x".repeat(1000));
        let dir = setup(&[("a.txt", long.as_bytes())]);
        let r = search(&dir, "needle", false, true);
        assert_eq!(r.hits[0].line_text.chars().count(), 500);
    }

    #[test]
    fn regex_escape_escapes_metacharacters() {
        assert_eq!(regex_escape("a.b*c"), r"a\.b\*c");
        assert_eq!(regex_escape("plain"), "plain");
        assert_eq!(regex_escape(r"\d"), r"\\d");
    }
}
