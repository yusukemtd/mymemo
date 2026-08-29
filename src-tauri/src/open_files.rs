// Finder の「このアプリケーションで開く」・ダブルクリック・Dock へのドロップで渡されたファイルの受け口。
// macOS はファイルを argv ではなく Apple Event(application:openURLs:)で渡すため、
// tauri::RunEvent::Opened を lib.rs の run クロージャで受けてここへ流す。
//
// 起動と同時に開かれた場合、Opened は RunEvent::Ready(= setup の実行、ウィンドウ生成)より
// 前に届く。そのため OpenFilesState は setup 内ではなく Builder::manage で登録しておく必要がある
// (setup 内で manage すると起動時の Opened で app.state() が panic し、FFI 境界を越えられず abort する)。
// フロントエンドのリスナー登録はさらに後なので、フロントが準備完了を申告する
// (take_pending_open_files)までは溜めておき、申告時にまとめて返す。
// 準備完了後に届いた分はイベント "open-files" で即時通知する。

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub const OPEN_FILES_EVENT: &str = "open-files";

#[derive(Default)]
pub struct PendingOpenFiles {
    ready: bool,
    paths: Vec<String>,
}

impl PendingOpenFiles {
    /// 届いたパスを受け付ける。フロントが準備済みなら即時通知すべきパスを返し、
    /// 未準備なら溜めて None を返す
    pub fn push(&mut self, paths: Vec<String>) -> Option<Vec<String>> {
        if self.ready {
            Some(paths)
        } else {
            self.paths.extend(paths);
            None
        }
    }

    /// フロントの準備完了を記録し、溜めていたパスを引き渡す
    pub fn take(&mut self) -> Vec<String> {
        self.ready = true;
        std::mem::take(&mut self.paths)
    }
}

pub struct OpenFilesState(pub Mutex<PendingOpenFiles>);

impl Default for OpenFilesState {
    fn default() -> Self {
        Self(Mutex::new(PendingOpenFiles::default()))
    }
}

/// フロントエンドが "open-files" のリスナー登録後に呼ぶ。
/// 起動と同時に渡されたファイルのパスを返す(以後は即時通知に切り替わる)
#[tauri::command]
pub fn take_pending_open_files(state: State<OpenFilesState>) -> Vec<String> {
    state.0.lock().unwrap().take()
}

/// RunEvent::Opened の URL のうち file:// のものをフロントへ渡す
pub fn handle_opened(app: &AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }
    let state = app.state::<OpenFilesState>();
    // 通知とキュー積みの順序が入れ替わらないよう、ロックを持ったまま emit する
    let mut pending = state.0.lock().unwrap();
    if let Some(paths) = pending.push(paths) {
        let _ = app.emit(OPEN_FILES_EVENT, paths);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn 準備前に届いたパスは溜めて_take_でまとめて返す() {
        let mut p = PendingOpenFiles::default();
        assert_eq!(p.push(v(&["/a.txt"])), None);
        assert_eq!(p.push(v(&["/b.md", "/c.md"])), None);
        assert_eq!(p.take(), v(&["/a.txt", "/b.md", "/c.md"]));
        // 引き渡した分は残らない
        assert_eq!(p.take(), Vec::<String>::new());
    }

    #[test]
    fn 準備後に届いたパスは溜めず即時通知用に返す() {
        let mut p = PendingOpenFiles::default();
        assert_eq!(p.take(), Vec::<String>::new());
        assert_eq!(p.push(v(&["/a.txt"])), Some(v(&["/a.txt"])));
        assert_eq!(p.take(), Vec::<String>::new());
    }

    #[test]
    fn 準備前後で溜めた分と即時分が混ざらない() {
        let mut p = PendingOpenFiles::default();
        assert_eq!(p.push(v(&["/early.txt"])), None);
        assert_eq!(p.take(), v(&["/early.txt"]));
        assert_eq!(p.push(v(&["/late.txt"])), Some(v(&["/late.txt"])));
    }
}
