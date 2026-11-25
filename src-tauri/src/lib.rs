//! unnotator アプリ本体（Tauri）。

/// アプリを起動する。
pub fn run() {
    tracing_subscriber::fmt::init();

    let result = tauri::Builder::default().run(tauri::generate_context!());
    if let Err(error) = result {
        tracing::error!(%error, "アプリの起動に失敗した");
    }
}
