//! IPC コマンド（contracts/ipc.md）。媒体に関係しない見本だけを置く。

use std::io::Write;

use serde::{Deserialize, Serialize};
use specta::Type;

/// 計測モードを有効にする環境変数。
pub const MEASURE_STARTUP_ENV: &str = "UNNOTATOR_MEASURE_STARTUP";

/// アプリ名と版数（型付きの通路が往復することを示す見本）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// アプリ名と版数を返す。失敗しない。
#[tauri::command]
#[specta::specta]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "unnotator".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// 起動時間の計測モードか。`UNNOTATOR_MEASURE_STARTUP=1` のときだけ true。
pub fn is_measure_startup(value: Option<&str>) -> bool {
    value == Some("1")
}

/// 計測用に標準出力へ書く行。
pub fn ready_line(elapsed_ms: u128) -> String {
    format!("UNNOTATOR_READY_MS={elapsed_ms}")
}

/// シェルの最初の描画が終わったことを知らせる。計測モードなら経過時間を出して正常終了する。
/// 計測用の出力が書けなくてもアプリは止めない。
#[tauri::command]
#[specta::specta]
pub fn report_ready(app: tauri::AppHandle) {
    let elapsed_ms = crate::process_start().elapsed().as_millis();
    if is_measure_startup(std::env::var(MEASURE_STARTUP_ENV).ok().as_deref()) {
        let mut stdout = std::io::stdout();
        if let Err(error) =
            writeln!(stdout, "{}", ready_line(elapsed_ms)).and_then(|()| stdout.flush())
        {
            tracing::warn!(%error, "計測用の出力を書けなかった");
        }
        app.exit(0);
    } else {
        // 開発時に「画面が出た」ことを、ログから確実に知る合図（scripts/dev/ui.mjs が待つ）。
        tracing::info!(
            elapsed_ms = elapsed_ms as u64,
            "UNNOTATOR_READY 最初の描画が終わった"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_returns_name_and_package_version() {
        let info = app_info();
        assert_eq!(info.name, "unnotator");
        assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn ready_line_has_the_documented_format() {
        assert_eq!(ready_line(1234), "UNNOTATOR_READY_MS=1234");
    }

    #[test]
    fn measure_startup_is_enabled_only_by_one() {
        assert!(is_measure_startup(Some("1")));
        assert!(!is_measure_startup(Some("0")));
        assert!(!is_measure_startup(Some("")));
        assert!(!is_measure_startup(None));
    }
}
