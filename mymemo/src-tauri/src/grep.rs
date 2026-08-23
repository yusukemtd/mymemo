use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkBuilder;
use serde::Serialize;

const MAX_HITS: usize = 5000;

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

#[tauri::command]
pub fn grep_search(
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
        let path_str = entry.path().to_string_lossy().to_string();
        let result = searcher.search_path(
            &matcher,
            entry.path(),
            UTF8(|line_number, line| {
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
        if result.is_err() {
            continue; // 読めないファイルはスキップ
        }
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
        grep_search(
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
        let err = grep_search(
            dir.path().to_string_lossy().into_owned(),
            "(".to_string(),
            true,
            true,
        );
        assert!(err.is_err());
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
