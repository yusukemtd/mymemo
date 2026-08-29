import * as Tabs from "./tabs.js";

// ディスク上の変更検知: 開いたときの更新時刻(tab.mtime、UNIX ミリ秒)とディスクの更新時刻を比べる。
// - ウィンドウが前面に戻ったとき: 変わっていれば読み直す(未保存の編集があるタブは確認してから)
// - 保存するとき: 変わっていれば上書きするか確認する
// tab.mtime が null のタブは「ディスク上の変更を知ったうえで編集を続けている」状態で、
// フォーカス時の確認は繰り返さず、保存時の上書き確認だけを行う

// フォーカス時にどうするか: "none"(何もしない)/ "reload"(黙って読み直す)/ "ask"(確認してから読み直す)
export function classify(tab, diskMtime) {
  if (!tab.path || tab.mtime == null || diskMtime == null) return "none"; // 無題・確認済み・ディスクから消えた
  if (diskMtime === tab.mtime) return "none";
  return tab.dirty ? "ask" : "reload";
}

// 上書き保存の前に確認が要るか(ディスクから消えている場合はそのまま書く)
export function needsOverwriteConfirm(tab, diskMtime) {
  return diskMtime != null && diskMtime !== tab.mtime;
}

// ディスクから読み直してタブの内容を差し替える(カーソル位置は保つ)。読めなければ例外
export async function reloadTab(tab, readFile) {
  const file = await readFile(tab.path, tab.encoding);
  Tabs.replaceContent(tab, file.content, file.encoding, file.mtime ?? null);
}

let checking = false;

// 全タブのディスク上の変更を確認する。deps: { fileMtime(path), readFile(path, encoding), confirm(tab) }。
// 確認ダイアログの開閉でフォーカスイベントが再度来るため、実行中は重ねて走らせない
export async function checkExternalChanges({ fileMtime, readFile, confirm }) {
  if (checking) return;
  checking = true;
  try {
    for (const tab of Tabs.getTabs().slice()) {
      if (!tab.path || !Tabs.getTabs().includes(tab)) continue; // 無題タブ・確認中に閉じられたタブ
      let disk;
      try {
        disk = await fileMtime(tab.path);
      } catch {
        continue;
      }
      const action = classify(tab, disk);
      if (action === "none") continue;
      if (action === "ask" && !(await confirm(tab))) {
        tab.mtime = null; // 以後はフォーカス時に聞き直さず、保存時に上書き確認する
        continue;
      }
      try {
        await reloadTab(tab, readFile);
      } catch (err) {
        console.error("読み直しに失敗しました", tab.path, err);
      }
    }
  } finally {
    checking = false;
  }
}
