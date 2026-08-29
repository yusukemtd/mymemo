use crate::file_io::{decode_auto, encode_text};
use encoding_rs::Encoding;
use grep_matcher::{Captures, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::sinks::Lossy;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::overrides::OverrideBuilder;
use ignore::WalkBuilder;
use serde::Serialize;
use std::fs;
use std::path::Path;

const MAX_HITS: usize = 5000;
// エンコーディング自動判定のため全読みするので、これを超えるファイルは検索対象外
const MAX_FILE_SIZE: u64 = 20 * 1024 * 1024;
const UTF8_BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

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

#[derive(Serialize)]
pub struct ReplaceResult {
    pub files: usize,
    pub replacements: usize,
}

// 同期コマンドはメインスレッドで実行され UI が固まるため、blocking スレッドへ逃がす。
// globs は "*.md" "!node_modules" のような絞り込み(gitignore と同じ書き方。空なら全ファイル)
#[tauri::command]
pub async fn grep_search(
    dir: String,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
    globs: Vec<String>,
) -> Result<GrepResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        grep_impl(dir, pattern, is_regex, case_sensitive, globs)
    })
    .await
    .map_err(|e| format!("検索スレッドエラー: {e}"))?
}

// 検索と同じ条件で一致をすべて replacement に置き換えてファイルへ書き戻す(元に戻せない)。
// 正規表現なら $1 / ${name} を展開する。文字コード・改行コード・UTF-8 BOM は元のまま
#[tauri::command]
pub async fn grep_replace(
    dir: String,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
    globs: Vec<String>,
    replacement: String,
) -> Result<ReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        replace_impl(dir, pattern, is_regex, case_sensitive, globs, replacement)
    })
    .await
    .map_err(|e| format!("置換スレッドエラー: {e}"))?
}

fn build_matcher(pattern: &str, is_regex: bool, case_sensitive: bool) -> Result<RegexMatcher, String> {
    let pat = if is_regex {
        pattern.to_string()
    } else {
        regex_escape(pattern)
    };
    RegexMatcherBuilder::new()
        .case_insensitive(!case_sensitive)
        .build(&pat)
        .map_err(|e| format!("正規表現エラー: {e}"))
}

// .gitignore や隠しファイルを尊重し、globs で絞り込んだ走査
fn build_walk(dir: &str, globs: &[String]) -> Result<ignore::Walk, String> {
    let mut builder = WalkBuilder::new(dir);
    if !globs.is_empty() {
        let mut ov = OverrideBuilder::new(dir);
        for g in globs {
            ov.add(g).map_err(|e| format!("ファイル名パターンエラー: {e}"))?;
        }
        builder.overrides(ov.build().map_err(|e| format!("ファイル名パターンエラー: {e}"))?);
    }
    Ok(builder.build())
}

// 検索対象として読むべきファイルなら bytes を返す(巨大・バイナリ・読めないものは None)
fn read_candidate(entry: &ignore::DirEntry) -> Option<Vec<u8>> {
    if !entry.file_type().map_or(false, |t| t.is_file()) {
        return None;
    }
    // エンコーディング自動判定のため全読みが必要なので、巨大ファイルは読む前に除外する
    if entry.metadata().map_or(true, |m| m.len() > MAX_FILE_SIZE) {
        return None;
    }
    let bytes = fs::read(entry.path()).ok()?;
    // NUL バイトを含むファイルはバイナリとしてスキップ。
    // ただし BOM 付き(UTF-16 等)は NUL バイトを含むのが正常なので除外しない
    if Encoding::for_bom(&bytes).is_none() && bytes.contains(&0) {
        return None;
    }
    Some(bytes)
}

fn grep_impl(
    dir: String,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
    globs: Vec<String>,
) -> Result<GrepResult, String> {
    let matcher = build_matcher(&pattern, is_regex, case_sensitive)?;

    let mut hits = Vec::new();
    let mut truncated = false;

    let mut searcher = SearcherBuilder::new()
        .binary_detection(BinaryDetection::quit(b'\x00'))
        .line_number(true)
        .build();

    for entry in build_walk(&dir, &globs)? {
        if truncated {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(bytes) = read_candidate(&entry) else {
            continue;
        };
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

fn replace_impl(
    dir: String,
    pattern: String,
    is_regex: bool,
    case_sensitive: bool,
    globs: Vec<String>,
    replacement: String,
) -> Result<ReplaceResult, String> {
    let matcher = build_matcher(&pattern, is_regex, case_sensitive)?;
    let mut result = ReplaceResult {
        files: 0,
        replacements: 0,
    };
    for entry in build_walk(&dir, &globs)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let Some(bytes) = read_candidate(&entry) else {
            continue;
        };
        let count = replace_in_file(entry.path(), bytes, &matcher, is_regex, &replacement)?;
        if count > 0 {
            result.files += 1;
            result.replacements += count;
        }
    }
    Ok(result)
}

// 1 ファイルを置換して書き戻し、置換した数を返す。正しく読めない(lossy な)ファイルは触らない
fn replace_in_file(
    path: &Path,
    bytes: Vec<u8>,
    matcher: &RegexMatcher,
    is_regex: bool,
    replacement: &str,
) -> Result<usize, String> {
    let had_bom = bytes.starts_with(&UTF8_BOM);
    let (text, enc, lossy) = decode_auto(bytes);
    if lossy {
        return Ok(0);
    }
    let haystack = text.as_bytes();
    let mut caps = matcher.new_captures().map_err(|e| e.to_string())?;
    let mut dst = Vec::with_capacity(haystack.len());
    let mut count = 0;
    matcher
        .replace_with_captures(haystack, &mut caps, &mut dst, |caps, dst| {
            count += 1;
            if is_regex {
                caps.interpolate(
                    |name| matcher.capture_index(name),
                    haystack,
                    replacement.as_bytes(),
                    dst,
                );
            } else {
                dst.extend_from_slice(replacement.as_bytes());
            }
            true
        })
        .map_err(|e| e.to_string())?;
    if count == 0 {
        return Ok(0);
    }
    // 一致は文字境界で、置換文字列も UTF-8 なので結果も UTF-8
    let new_text = String::from_utf8(dst).map_err(|e| e.to_string())?;
    let mut out = if enc.name() == "UTF-8" && had_bom {
        UTF8_BOM.to_vec()
    } else {
        Vec::new()
    };
    out.extend(encode_text(&new_text, enc).map_err(|e| format!("{}: {e}", path.display()))?);
    fs::write(path, out).map_err(|e| format!("{}: 書き込みエラー: {e}", path.display()))?;
    Ok(count)
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
        search_globs(dir, pat, is_regex, case, &[])
    }

    fn search_globs(
        dir: &tempfile::TempDir,
        pat: &str,
        is_regex: bool,
        case: bool,
        globs: &[&str],
    ) -> GrepResult {
        grep_impl(
            dir.path().to_string_lossy().into_owned(),
            pat.to_string(),
            is_regex,
            case,
            globs.iter().map(|g| g.to_string()).collect(),
        )
        .unwrap()
    }

    fn replace(
        dir: &tempfile::TempDir,
        pat: &str,
        is_regex: bool,
        globs: &[&str],
        replacement: &str,
    ) -> ReplaceResult {
        replace_impl(
            dir.path().to_string_lossy().into_owned(),
            pat.to_string(),
            is_regex,
            true,
            globs.iter().map(|g| g.to_string()).collect(),
            replacement.to_string(),
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
            vec![],
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

    #[test]
    fn globs_filter_files_and_exclude() {
        let dir = setup(&[("a.md", b"needle\n"), ("b.txt", b"needle\n"), ("skip.md", b"needle\n")]);
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/c.md"), b"needle\n").unwrap();
        let r = search_globs(&dir, "needle", false, true, &["*.md"]);
        let mut names: Vec<_> = r.hits.iter().map(|h| h.path.rsplit('/').next().unwrap().to_string()).collect();
        names.sort();
        assert_eq!(names, ["a.md", "c.md", "skip.md"]); // サブフォルダも対象
        let r = search_globs(&dir, "needle", false, true, &["*.md", "!skip.md"]);
        assert_eq!(r.hits.len(), 2);
        assert!(r.hits.iter().all(|h| !h.path.ends_with("skip.md")));
        let err = grep_impl(dir.path().to_string_lossy().into_owned(), "x".into(), false, true, vec!["[".into()]);
        assert!(err.is_err());
    }

    #[test]
    fn replace_literal_keeps_line_endings_and_counts() {
        let dir = setup(&[("a.txt", b"foo bar\r\nfoo\r\n"), ("b.txt", b"none\n"), ("c.md", b"foo\n")]);
        let r = replace(&dir, "foo", false, &["*.txt"], "baz");
        assert_eq!((r.files, r.replacements), (1, 2));
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"baz bar\r\nbaz\r\n");
        assert_eq!(fs::read(dir.path().join("b.txt")).unwrap(), b"none\n");
        assert_eq!(fs::read(dir.path().join("c.md")).unwrap(), b"foo\n"); // glob 外は触らない
    }

    #[test]
    fn replace_regex_expands_groups() {
        let dir = setup(&[("a.txt", b"2024-01-15\n")]);
        let r = replace(&dir, r"(\d+)-(\d+)-(\d+)", true, &[], "$3/$2/$1");
        assert_eq!(r.replacements, 1);
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"15/01/2024\n");
        // 非正規表現では $1 をそのまま書く
        replace(&dir, "15", false, &[], "$1");
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"$1/01/2024\n");
    }

    #[test]
    fn replace_keeps_encoding_and_bom() {
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("古い日本語\n");
        let mut bom = UTF8_BOM.to_vec();
        bom.extend_from_slice("old\n".as_bytes());
        let mut u16 = vec![0xFF, 0xFE];
        for u in "old\n".encode_utf16() {
            u16.extend_from_slice(&u.to_le_bytes());
        }
        let dir = setup(&[("sjis.txt", &sjis[..]), ("bom.txt", &bom[..]), ("u16.txt", &u16[..])]);
        assert_eq!(replace(&dir, "古い", false, &[], "新しい").replacements, 1);
        let (expect, _, _) = encoding_rs::SHIFT_JIS.encode("新しい日本語\n");
        assert_eq!(fs::read(dir.path().join("sjis.txt")).unwrap(), expect.as_ref());
        assert_eq!(replace(&dir, "old", false, &[], "new").files, 2);
        let mut expect_bom = UTF8_BOM.to_vec();
        expect_bom.extend_from_slice("new\n".as_bytes());
        assert_eq!(fs::read(dir.path().join("bom.txt")).unwrap(), expect_bom);
        let mut expect_u16 = vec![0xFF, 0xFE];
        for u in "new\n".encode_utf16() {
            expect_u16.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(fs::read(dir.path().join("u16.txt")).unwrap(), expect_u16);
    }

    #[test]
    fn replace_skips_unreadable_and_unencodable_files() {
        // 正しく読めないファイル(不正な UTF-8 かつ CP932/EUC-JP としても不正: 0x81 の直後に改行)は触らない
        let dir = setup(&[("bad.txt", b"old \x81\n")]);
        let before = fs::read(dir.path().join("bad.txt")).unwrap();
        assert_eq!(replace(&dir, "old", false, &[], "new").files, 0);
        assert_eq!(fs::read(dir.path().join("bad.txt")).unwrap(), before);
        // CP932 で表現できない文字への置換はエラーにしてファイルを壊さない(ASCII だけだと UTF-8 と判定されるので日本語を含める)
        let (sjis, _, _) = encoding_rs::SHIFT_JIS.encode("old 日本語\n");
        let dir = setup(&[("sjis.txt", &sjis[..])]);
        let err = replace_impl(dir.path().to_string_lossy().into_owned(), "old".into(), false, true, vec![], "🍣".into());
        assert!(err.is_err());
        assert_eq!(fs::read(dir.path().join("sjis.txt")).unwrap(), sjis.as_ref());
    }
}
