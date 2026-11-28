//! unnotator アプリ本体（Tauri）。

pub mod asset_commands;
pub mod commands;
pub mod extension_commands;
pub mod open_commands;
pub mod project_commands;
pub mod query_commands;
pub mod selftest;
pub mod settings_commands;
pub mod tree_commands;
pub mod unno_protocol;

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
            selftest::report_selftest,
            extension_commands::extension_install,
            extension_commands::extension_remove,
            extension_commands::extension_list,
            extension_commands::extension_problems,
            extension_commands::extension_get,
            extension_commands::extension_set_enabled,
            extension_commands::extension_pin,
            extension_commands::extension_permissions,
            extension_commands::extension_consent,
            extension_commands::extension_revoke,
            extension_commands::extension_check_permission,
            extension_commands::ext_apply_command,
            extension_commands::ext_method_allowed,
            extension_commands::ext_labels_list,
            extension_commands::ext_schemas_list,
            extension_commands::ext_asset_get,
            extension_commands::ext_item_get,
            extension_commands::ext_annotations_query,
            extension_commands::ext_relations_query,
            extension_commands::ext_groups_query,
            extension_commands::ext_asset_read,
            extension_commands::ext_storage_get,
            extension_commands::ext_storage_set,
            extension_commands::ext_project_file_read,
            extension_commands::ext_project_file_write,
            extension_commands::ext_log,
            extension_commands::devmode_get,
            extension_commands::devmode_set,
            extension_commands::devmode_add_folder,
            extension_commands::devmode_remove_folder,
            extension_commands::media_rules_override,
            extension_commands::blob_dir,
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
            project_commands::label_usage,
            query_commands::labels_list,
            query_commands::schemas_list,
            query_commands::target_details,
            query_commands::annotations_page,
            query_commands::attribute_usage,
            asset_commands::asset_list,
            asset_commands::asset_get,
            asset_commands::asset_scan,
            asset_commands::asset_scan_cancel,
            asset_commands::asset_relink_candidates,
            asset_commands::asset_relink,
            asset_commands::asset_delete,
            asset_commands::asset_set_media_rules,
            tree_commands::tree_view_set,
            tree_commands::tree_rows,
            tree_commands::tree_locate,
            tree_commands::tree_neighbor,
            tree_commands::item_statuses,
            tree_commands::media_traits,
            open_commands::open_in_default_app,
            settings_commands::settings_get,
            settings_commands::settings_set,
            settings_commands::settings_unset,
            settings_commands::settings_keys,
            settings_commands::settings_layer,
            settings_commands::settings_warnings,
            settings_commands::settings_reload,
            settings_commands::extensions_check
        ])
        .events(collect_events![
            project_commands::ProjectChanged,
            project_commands::ProjectStateChanged,
            asset_commands::ScanProgressEvent,
            asset_commands::AssetsChanged,
            settings_commands::SettingsChangedEvent,
            extension_commands::ExtensionsChanged,
            extension_commands::PermissionsChanged,
            extension_commands::DevExtensionChanged
        ])
}

/// TypeScript の型と呼び出し関数を書き出す。
pub fn export_bindings(path: &Path) -> Result<(), specta_typescript::Error> {
    ipc_builder().export(Typescript::default(), path)
}

/// アプリの領域の置き場。実行ファイルの隣に `data/` があれば、ポータブル版として、その下にすべてを置く。
pub fn app_paths(app: &tauri::App) -> Result<unnotator_extensions::paths::AppPaths, tauri::Error> {
    use unnotator_extensions::paths::AppPaths;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf));
    if let Some(dir) = exe_dir.filter(|dir| dir.join("data").is_dir()) {
        return Ok(AppPaths::portable(&dir));
    }
    Ok(AppPaths::new(
        &app.path().app_data_dir()?,
        &app.path().app_cache_dir()?,
    ))
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

    let result =
        unno_protocol::register(tauri::Builder::default().plugin(tauri_plugin_dialog::init()))
            .on_page_load(|webview, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    selftest::on_page_loaded(webview);
                }
            })
            .invoke_handler(builder.invoke_handler())
            .setup(move |app| {
                builder.mount_events(app);
                #[cfg(target_os = "macos")]
                install_quit_menu(app)?;
                // 作業用データの置き場は、アプリのデータフォルダの下
                let recovery_root = app.path().app_data_dir()?.join("recovery");
                // 30 日を超えた孤立の作業用データを、背景で片付ける（開く処理を待たせない）
                let cleanup_root = recovery_root.clone();
                std::thread::spawn(move || project_commands::cleanup_recovery(&cleanup_root));
                let user_settings = app.path().app_config_dir()?;
                app.manage(
                    project_commands::ProjectState::new(recovery_root)
                        .with_user_settings_dir(user_settings),
                );
                app.manage(selftest::SelfTest::default());
                // `unno://` の配信（ブロブの置き場は、起動のたびに空にする）
                let paths = app_paths(app)?;
                let blobs = unnotator_core::serve::BlobStore::open(paths.blobs_dir())?;
                if let Err(error) = blobs.clear() {
                    tracing::warn!(%error, "ブロブの置き場を空にできなかった");
                }
                let serve = unno_protocol::ServeState::new(
                    blobs,
                    unnotator_core::serve::PreviewCache::new(paths.previews_dir()),
                );
                let runtime = extension_commands::ExtensionRuntime::new(paths, &serve);
                app.manage(serve);
                app.manage(runtime);
                extension_commands::start_dev_watch(app.handle());
                Ok(())
            })
            .build(tauri::generate_context!());
    match result {
        Ok(app) => app.run(on_run_event),
        Err(error) => tracing::error!(%error, "アプリの起動に失敗した"),
    }
}

/// 終了の要求。プロジェクトが開いているあいだは終了せず、ウィンドウを閉じるときと同じ流れ
/// （未保存の確認 → 閉じる）に回す。閉じ終えたあとの終了は、プロジェクトが開いていないので、そのまま通る。
/// 戻り値は、終了を止めて確認の流れに回したとき true。
fn divert_quit(app: &tauri::AppHandle) -> bool {
    use tauri::Emitter;
    let open = app
        .try_state::<project_commands::ProjectState>()
        .is_some_and(|state| state.has_project());
    if !open {
        return false;
    }
    if let Some(window) = app.get_webview_window("main") {
        // フロントの `onCloseRequested` が受け取るのと同じ名前の通知
        let _ = window.emit("tauri://close-requested", ());
    }
    true
}

/// Dock の「終了」などは、ウィンドウの閉じる要求を通らずに終了の要求になる。
fn on_run_event(app: &tauri::AppHandle, event: tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested {
        api, code: None, ..
    } = event
        && divert_quit(app)
    {
        api.prevent_exit();
    }
}

/// macOS の標準メニューの「終了」（Cmd+Q）は、OS が直接アプリを終わらせて、止められない。
/// 自前の項目に差し替えて、`divert_quit` を通す。
#[cfg(target_os = "macos")]
fn install_quit_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let handle = app.handle();
    let menu = Menu::default(handle)?;
    // 先頭のサブメニューがアプリのメニューで、「終了」はその最後の項目
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let quit_name = format!("Quit {}", handle.package_info().name);
        app_menu.remove_at(app_menu.items()?.len().saturating_sub(1))?;
        app_menu.append(&MenuItem::with_id(
            handle,
            "app-quit",
            quit_name,
            true,
            Some("CmdOrCtrl+Q"),
        )?)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "app-quit" && !divert_quit(app) {
            app.exit(0);
        }
    });
    Ok(())
}
