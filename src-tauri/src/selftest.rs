//! S-01 の自己診断。実機の WebView で、`unno://` の配信（Range・CSP・ES モジュール・メディア要素・同時読み取り）を確かめる。
//!
//! `UNNOTATOR_SELFTEST=unno pnpm tauri dev`（デバッグビルドだけ）で動く。診断用のファイルを一時フォルダに作り、
//! ページの読み込みが終わったら、`selftest/unno.js` をメインのウィンドウで実行する。結果は `report_selftest` で戻り、
//! 標準出力に `UNNO_SELFTEST_RESULT {...}` として書いて、アプリを終了する（成功 0・失敗 1）。3 OS の CI でも同じものを回せる。
//! 診断用の素材は `src-tauri/selftest/` にあり、この層はバイト列として扱う（媒体の中身は解釈しない）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::assets::{AssetFilter, Page};
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{Origin, RawExtension, Registry, RegistryInput};
use unnotator_extensions::state::ExtensionsState;

use crate::asset_commands::{list, scan};
use crate::project_commands::{Hooks, IpcError, ProjectState, open_project};
use crate::unno_protocol::ServeState;

const ENV: &str = "UNNOTATOR_SELFTEST";
const SCRIPT: &str = include_str!("../selftest/unno.js");
const MANIFEST: &str = include_str!("../selftest/manifest.json");
const MODULE: &str = include_str!("../selftest/index.js");
const TONE: &[u8] = include_bytes!("../selftest/silence.wav");

/// 診断を求められているか（デバッグビルドで、環境変数が `unno`）。
pub fn requested() -> bool {
    cfg!(debug_assertions) && std::env::var(ENV).is_ok_and(|v| v == "unno")
}

/// 診断の実行中の状態。`report_selftest` が、これを持つときだけ受け付ける。
#[derive(Default)]
pub struct SelfTest {
    started: AtomicBool,
    finished: AtomicBool,
    peak_rss_kib: AtomicU64,
    dir: Mutex<Option<PathBuf>>,
}

fn pattern(len: usize, offset: usize) -> Vec<u8> {
    (0..len).map(|i| ((offset + i) % 251) as u8).collect()
}

fn big_size() -> u64 {
    if cfg!(unix) { 1 << 30 } else { 256 << 20 }
}

/// 診断用のファイル・拡張機能・プロジェクトを用意し、ページで実行する JS を返す。
fn prepare<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<(String, PathBuf), String> {
    let dir = std::env::temp_dir().join(format!("unnotator-selftest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let project_dir = dir.join("project");
    let ext_dir = dir.join("ext");
    std::fs::create_dir_all(&project_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(ext_dir.join("dist")).map_err(|e| e.to_string())?;

    // 本体の位置 i のバイトは (i % 251)
    let small = 3 * 1024 * 1024;
    std::fs::write(project_dir.join("small.bin"), pattern(small, 0)).map_err(|e| e.to_string())?;
    {
        // 大きなファイル: 先頭だけ書き、残りは書かない（疎なファイル）
        let file = std::fs::File::create(project_dir.join("big.bin")).map_err(|e| e.to_string())?;
        file.set_len(big_size()).map_err(|e| e.to_string())?;
        use std::io::Write;
        (&file)
            .write_all(&pattern(4096, 0))
            .map_err(|e| e.to_string())?;
    }
    std::fs::write(project_dir.join("tone.wav"), TONE).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("secret.txt"), b"secret").map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("unnotator-plugin.json"), MANIFEST).map_err(|e| e.to_string())?;
    std::fs::write(ext_dir.join("dist/index.js"), MODULE).map_err(|e| e.to_string())?;

    let serve = app.state::<ServeState>();
    std::fs::write(serve.blobs.dir().join("selftest.bin"), b"blob-ok")
        .map_err(|e| e.to_string())?;

    // 登録簿（拡張機能の宣言が `Content-Type` を決める）
    let manifest: Value = serde_json::from_str(MANIFEST).map_err(|e| e.to_string())?;
    let manifest = Manifest::from_value(manifest)?;
    let raw = RawExtension::new(ext_dir, Origin::Dev, manifest);
    let state = ExtensionsState::default();
    let registry = Registry::build(RegistryInput {
        installed: &[raw],
        state: &state,
        app_api_version: unnotator_extensions::EXTENSION_API_VERSION,
    });
    serve.update(&registry, &state);

    // プロジェクトを開いて走査する
    let project = app.state::<ProjectState>();
    open_project(&project, &project_dir, true, Hooks::default()).map_err(|e| e.message)?;
    scan(&project, ScanScope::Full, &|_| {}).map_err(|e| e.message)?;
    let page = list(&project, &AssetFilter::default(), &Page::first(10)).map_err(|e| e.message)?;
    let id_of = |name: &str| -> Result<String, String> {
        page.items
            .iter()
            .find(|a| a.rel_path == name)
            .map(|a| a.id.clone())
            .ok_or_else(|| format!("{name} が登録されていない"))
    };
    let config = json!({
        "base": if cfg!(windows) { "http://unno.localhost" } else { "unno://localhost" },
        "smallId": id_of("small.bin")?,
        "smallSize": small,
        "bigId": id_of("big.bin")?,
        "bigSize": big_size(),
        "toneId": id_of("tone.wav")?,
        "blobName": "selftest.bin",
        "extId": "com.example.selftest",
    });
    Ok((
        format!("window.__UNNO_SELFTEST__ = {config};\n{SCRIPT}"),
        dir,
    ))
}

#[cfg(unix)]
fn rss_kib() -> Option<u64> {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(not(unix))]
fn rss_kib() -> Option<u64> {
    None
}

/// ページの読み込みが終わったとき（メインのウィンドウ）に呼ぶ。診断を求められていなければ、何もしない。
pub fn on_page_loaded<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    if !requested() || webview.label() != "main" {
        return;
    }
    let app = webview.app_handle().clone();
    let state = app.state::<SelfTest>();
    if state.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let webview = webview.clone();
    std::thread::spawn(move || match prepare(&app) {
        Ok((script, dir)) => {
            if let Ok(mut slot) = app.state::<SelfTest>().dir.lock() {
                *slot = Some(dir);
            }
            // メモリの最大値を見張る
            let watcher_app = app.clone();
            std::thread::spawn(move || {
                let state = watcher_app.state::<SelfTest>();
                while !state.finished.load(Ordering::SeqCst) {
                    if let Some(kib) = rss_kib() {
                        state.peak_rss_kib.fetch_max(kib, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            });
            if let Err(error) = webview.eval(&script) {
                finish(
                    &app,
                    json!({ "fatal": { "ok": false, "error": error.to_string() } }),
                    None,
                );
            }
        }
        Err(error) => finish(
            &app,
            json!({ "fatal": { "ok": false, "error": error } }),
            None,
        ),
    });
}

fn finish<R: tauri::Runtime>(app: &AppHandle<R>, results: Value, user_agent: Option<String>) {
    let state = app.state::<SelfTest>();
    state.finished.store(true, Ordering::SeqCst);
    let ok = results
        .as_object()
        .is_some_and(|m| !m.is_empty() && m.values().all(|v| v["ok"] == json!(true)));
    let serve = app.state::<ServeState>();
    let output = json!({
        "ok": ok,
        "os": std::env::consts::OS,
        "userAgent": user_agent,
        "results": results,
        "server": {
            "requests": serve.stats.requests.load(Ordering::SeqCst),
            "ranged": serve.stats.ranged.load(Ordering::SeqCst),
            "peakRssKib": state.peak_rss_kib.load(Ordering::SeqCst),
            "bigFileBytes": big_size(),
        },
    });
    println!("UNNO_SELFTEST_RESULT {output}");
    if let Ok(slot) = state.dir.lock()
        && let Some(dir) = slot.as_deref()
    {
        cleanup(dir);
    }
    app.exit(if ok { 0 } else { 1 });
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

/// 診断の結果を受け取る（診断を求められたときだけ受け付ける）。
#[tauri::command]
#[specta::specta]
pub fn report_selftest(app: AppHandle, report: String) -> Result<(), IpcError> {
    if !requested() || app.try_state::<SelfTest>().is_none() {
        return Err(IpcError {
            code: "not_running".to_owned(),
            message: "自己診断は実行中ではありません".to_owned(),
        });
    }
    let parsed: Value = serde_json::from_str(&report).map_err(|e| IpcError {
        code: "invalid_report".to_owned(),
        message: e.to_string(),
    })?;
    let results = parsed["results"].clone();
    let user_agent = parsed["userAgent"].as_str().map(str::to_owned);
    finish(&app, results, user_agent);
    Ok(())
}
