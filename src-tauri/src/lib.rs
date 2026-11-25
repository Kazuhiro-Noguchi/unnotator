//! unnotator アプリ本体（Tauri）。

pub mod commands;
pub mod project_commands;

#[cfg(test)]
mod bindings_test;

use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

use specta_typescript::Typescript;
use tauri::Manager;
use tauri_specta::{Builder, collect_commands, collect_events};

static PROCESS_START: OnceLock<Instant> = OnceLock::new();

/// プロセス開始（`run` の呼び出し）からの経過時間の起点。
pub fn process_start() -> Instant {
    *PROCESS_START.get_or_init(Instant::now)
}

/// 型付き IPC のコマンドの登録。
pub fn ipc_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app_info,
            commands::report_ready,
            project_commands::project_open,
            project_commands::project_close,
            project_commands::project_save,
            project_commands::save_state,
            project_commands::recovery_restore,
            project_commands::recovery_discard,
            project_commands::recovery_list,
            project_commands::recovery_delete,
            project_commands::apply_command,
            project_commands::undo,
            project_commands::redo,
            project_commands::undo_state,
            project_commands::label_usage
        ])
        .events(collect_events![
            project_commands::ProjectChanged,
            project_commands::ProjectStateChanged
        ])
}

/// TypeScript の型と呼び出し関数を書き出す。
pub fn export_bindings(path: &Path) -> Result<(), specta_typescript::Error> {
    ipc_builder().export(Typescript::default(), path)
}

/// アプリを起動する。
pub fn run() {
    process_start();
    tracing_subscriber::fmt::init();

    let builder = ipc_builder();

    // debug ビルドでは起動のたびに生成し直す（開発中に手で生成しなくて済むように）。
    #[cfg(debug_assertions)]
    {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/bindings.ts");
        if let Err(error) = export_bindings(&path) {
            tracing::warn!(%error, "bindings.ts を書き出せなかった");
        }
    }

    let result = tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            // 作業用データの置き場は、アプリのデータフォルダの下
            let recovery_root = app.path().app_data_dir()?.join("recovery");
            // 30 日を超えた孤立の作業用データを、背景で片付ける（開く処理を待たせない）
            let cleanup_root = recovery_root.clone();
            std::thread::spawn(move || project_commands::cleanup_recovery(&cleanup_root));
            app.manage(project_commands::ProjectState::new(recovery_root));
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(error) = result {
        tracing::error!(%error, "アプリの起動に失敗した");
    }
}
