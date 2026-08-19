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
