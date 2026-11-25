//! 拡張機能の IPC（contracts/ipc.md）。状態の保持と型の変換だけを行う薄い層。
//! 検証・解決・権限の中身は `unnotator-extensions` にある。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_specta::Event;
use unnotator_extensions::ExtensionError;
use unnotator_extensions::consent::{ConsentStore, PermissionVerdict};
use unnotator_extensions::devmode::{DevWatcher, load_active_folders};
use unnotator_extensions::package::{InstallOutcome, install_package};
use unnotator_extensions::paths::AppPaths;
use unnotator_extensions::registry::{
    ExtensionEntry, ExtensionStatus, Origin, Problem, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;
use unnotator_extensions::store::{cleanup_staging, remove_extension, scan_installed};

use crate::asset_commands::set_rules;
use crate::project_commands::{IpcError, ProjectState};
use crate::unno_protocol::ServeState;

/// アプリの拡張 API の版（`packages/plugin-api` と一致）。
const API_VERSION: &str = unnotator_extensions::EXTENSION_API_VERSION;

impl From<ExtensionError> for IpcError {
    fn from(error: ExtensionError) -> Self {
        let code = match &error {
            ExtensionError::Io(_) | ExtensionError::Write(_) | ExtensionError::Json(_) => "io",
            ExtensionError::Package(_) => "package",
            ExtensionError::AlreadyInstalled { .. } => "already_installed",
            ExtensionError::NotFound(_) => "not_found",
            ExtensionError::Invalid(_) => "invalid",
            ExtensionError::DevModeOff => "dev_mode_off",
        };
        Self {
            code: code.to_owned(),
            message: error.to_string(),
        }
    }
}

/// 拡張機能の状態（登録簿・利用者の状態・同意）。
pub struct ExtensionRuntime {
    paths: AppPaths,
    registry: RwLock<Arc<Registry>>,
    state: Mutex<ExtensionsState>,
    consent: Mutex<ConsentStore>,
    /// 開発中のフォルダの組が変わるたびに進む（見張りのスレッドが作り直す）。
    dev_generation: AtomicU64,
}

fn lock_err<T>(_: T) -> IpcError {
    IpcError {
        code: "internal".to_owned(),
        message: "内部の状態を取れませんでした".to_owned(),
    }
}

impl ExtensionRuntime {
    /// 起動時: 作業フォルダの片付け・状態の読み込み・走査・登録簿の構築。
    pub fn new(paths: AppPaths, serve: &ServeState) -> Self {
        if let Err(error) = cleanup_staging(&paths) {
            tracing::warn!(%error, "取り込みの作業フォルダを片付けられなかった");
        }
        let state = ExtensionsState::load(&paths.state_file());
        let consent = ConsentStore::open(&paths.permissions_file());
        let runtime = Self {
            paths,
            registry: RwLock::new(Arc::new(Registry::default())),
            state: Mutex::new(state),
            consent: Mutex::new(consent),
            dev_generation: AtomicU64::new(0),
        };
        let _ = runtime.rebuild(serve);
        runtime
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    pub fn registry(&self) -> Arc<Registry> {
        self.registry
            .read()
            .map(|r| Arc::clone(&r))
            .unwrap_or_default()
    }

    pub(crate) fn dev_generation(&self) -> u64 {
        self.dev_generation.load(Ordering::SeqCst)
    }

    /// 導入済みと開発中を読み直して、登録簿を作り直し、配信の情報を入れ替える。
    pub fn rebuild(&self, serve: &ServeState) -> Result<Arc<Registry>, IpcError> {
        let state = self.state.lock().map_err(lock_err)?.clone();
        let scanned = scan_installed(&self.paths);
        let (dev, dev_problems) = load_active_folders(&state);
        let mut all = scanned.found;
        all.extend(dev);
        let mut registry = Registry::build(RegistryInput {
            installed: &all,
            state: &state,
            app_api_version: API_VERSION,
        });
        registry.add_problems(scanned.problems.into_iter().chain(dev_problems));
        let registry = Arc::new(registry);
        serve.update(&registry, &state);
        *self.registry.write().map_err(lock_err)? = Arc::clone(&registry);
        Ok(registry)
    }

    fn with_state<T>(
        &self,
        f: impl FnOnce(&mut ExtensionsState) -> Result<T, ExtensionError>,
    ) -> Result<T, IpcError> {
        let mut guard = self.state.lock().map_err(lock_err)?;
        let mut next = guard.clone();
        let value = f(&mut next)?;
        next.save(&self.paths.state_file())?;
        *guard = next;
        Ok(value)
    }

    fn dev_folders(&self) -> Vec<(String, PathBuf)> {
        let registry = self.registry();
        registry
            .extensions()
            .iter()
            .filter(|e| e.origin == Origin::Dev)
            .map(|e| (e.id.clone(), e.dir.clone()))
            .collect()
    }
}

// ---- DTO ----

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProblemDto {
    pub extension_id: String,
    pub version: Option<String>,
    pub kind: String,
    pub pointer: String,
    pub message: String,
    /// 構造化した詳細（JSON の文字列）。
    pub detail: Option<String>,
}

impl From<&Problem> for ProblemDto {
    fn from(p: &Problem) -> Self {
        Self {
            extension_id: p.extension_id.clone(),
            version: p.version.clone(),
            kind: serde_json::to_value(p.kind)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default(),
            pointer: p.pointer.clone(),
            message: p.message.clone(),
            detail: p.detail.as_ref().map(ToString::to_string),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExtensionEntryDto {
    pub id: String,
    pub version: String,
    /// `installed` / `dev`
    pub origin: String,
    /// `enabled` / `disabled` / `invalid`
    pub status: String,
    /// `user_disabled` / `dependency_disabled`（`status` が `disabled` のとき）
    pub disabled_reason: Option<String>,
    pub order: Option<u32>,
    pub display_name: Option<String>,
    pub installed_versions: Vec<String>,
    pub problems: Vec<ProblemDto>,
}

fn entry_dto(registry: &Registry, e: &ExtensionEntry, language: &str) -> ExtensionEntryDto {
    use unnotator_extensions::registry::DisabledReason;
    let (status, order, reason) = match e.status {
        ExtensionStatus::Enabled { order } => ("enabled", u32::try_from(order).ok(), None),
        ExtensionStatus::Disabled(r) => (
            "disabled",
            None,
            Some(match r {
                DisabledReason::UserDisabled => "user_disabled",
                DisabledReason::DependencyDisabled => "dependency_disabled",
            }),
        ),
        ExtensionStatus::Invalid => ("invalid", None, None),
    };
    ExtensionEntryDto {
        id: e.id.clone(),
        version: e.version.clone(),
        origin: match e.origin {
            Origin::Installed => "installed",
            Origin::Dev => "dev",
        }
        .to_owned(),
        status: status.to_owned(),
        disabled_reason: reason.map(str::to_owned),
        order,
        display_name: e
            .manifest
            .display_name
            .as_deref()
            .map(|n| registry.text(&e.id, n, language)),
        installed_versions: e.installed_versions.clone(),
        problems: registry
            .problems()
            .iter()
            .filter(|p| p.extension_id == e.id)
            .map(ProblemDto::from)
            .collect(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExtensionDetailDto {
    pub entry: ExtensionEntryDto,
    /// 参照を解決したマニフェスト（有効なものだけ。JSON の文字列）。
    pub manifest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PendingPermissionDto {
    pub permission: String,
    pub warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PermissionStateDto {
    pub declared: Vec<String>,
    pub pending: Vec<PendingPermissionDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PermissionVerdictDto {
    /// `allowed` / `needs_consent` / `denied`
    pub verdict: String,
    pub warning: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DevModeDto {
    pub enabled: bool,
    pub folders: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct InstallOutcomeDto {
    pub id: String,
    pub version: String,
    pub already_installed: bool,
}

// ---- イベント ----

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ExtensionsChanged {
    /// `install` / `remove` / `state` / `dev` / `startup`
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PermissionsChanged {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct DevExtensionChanged {
    pub id: String,
}

// ---- 操作（テストできる形。Tauri に依らない） ----

/// 登録簿を作り直し、開いているプロジェクトの判定規則へ流し込む。
pub fn refresh(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
) -> Result<Arc<Registry>, IpcError> {
    let registry = rt.rebuild(serve)?;
    let state = rt.state.lock().map_err(lock_err)?.clone();
    match set_rules(project, registry.media_rules(&state)) {
        Ok(_) => {}
        Err(e) if e.code == "not_open" => {}
        Err(e) => return Err(e),
    }
    Ok(registry)
}

fn find_entry(registry: &Registry, id: &str) -> Result<ExtensionEntry, IpcError> {
    registry
        .entry(id)
        .cloned()
        .ok_or_else(|| ExtensionError::NotFound(id.to_owned()).into())
}

pub fn install(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    path: &str,
) -> Result<InstallOutcomeDto, IpcError> {
    let outcome = install_package(rt.paths(), std::path::Path::new(path))?;
    refresh(rt, serve, project)?;
    Ok(match outcome {
        InstallOutcome::Installed { id, version } => InstallOutcomeDto {
            id,
            version,
            already_installed: false,
        },
        InstallOutcome::AlreadyInstalled { id, version } => InstallOutcomeDto {
            id,
            version,
            already_installed: true,
        },
    })
}

pub fn remove(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    id: &str,
    version: Option<&str>,
) -> Result<(), IpcError> {
    remove_extension(rt.paths(), id, version)?;
    if version.is_none() {
        rt.consent.lock().map_err(lock_err)?.forget(id)?;
    }
    refresh(rt, serve, project)?;
    Ok(())
}

pub fn list(rt: &ExtensionRuntime, language: &str) -> Vec<ExtensionEntryDto> {
    let registry = rt.registry();
    registry
        .extensions()
        .iter()
        .map(|e| entry_dto(&registry, e, language))
        .collect()
}

pub fn problems(rt: &ExtensionRuntime) -> Vec<ProblemDto> {
    rt.registry()
        .problems()
        .iter()
        .map(ProblemDto::from)
        .collect()
}

pub fn detail(
    rt: &ExtensionRuntime,
    id: &str,
    language: &str,
) -> Result<ExtensionDetailDto, IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    Ok(ExtensionDetailDto {
        entry: entry_dto(&registry, &entry, language),
        manifest: registry.resolved_manifest(id).map(ToString::to_string),
    })
}

pub fn set_enabled(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    id: &str,
    enabled: bool,
) -> Result<(), IpcError> {
    rt.with_state(|s| {
        s.set_disabled(id, !enabled);
        Ok(())
    })?;
    refresh(rt, serve, project)?;
    Ok(())
}

pub fn pin(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    id: &str,
    version: Option<&str>,
) -> Result<(), IpcError> {
    rt.with_state(|s| s.pin(id, version))?;
    refresh(rt, serve, project)?;
    Ok(())
}

pub fn permissions(rt: &ExtensionRuntime, id: &str) -> Result<PermissionStateDto, IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    let consent = rt.consent.lock().map_err(lock_err)?;
    Ok(PermissionStateDto {
        declared: entry.manifest.permissions.clone(),
        pending: consent
            .pending(&entry)
            .into_iter()
            .map(|p| PendingPermissionDto {
                permission: p.permission,
                warning: p.warning,
            })
            .collect(),
    })
}

pub fn consent(rt: &ExtensionRuntime, id: &str, permissions: &[String]) -> Result<(), IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    rt.consent
        .lock()
        .map_err(lock_err)?
        .grant(&entry, permissions)?;
    Ok(())
}

pub fn revoke(rt: &ExtensionRuntime, id: &str, permissions: &[String]) -> Result<(), IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    rt.consent
        .lock()
        .map_err(lock_err)?
        .revoke(id, &entry.version, permissions)?;
    Ok(())
}

pub fn check_permission(
    rt: &ExtensionRuntime,
    id: &str,
    permission: &str,
) -> Result<PermissionVerdictDto, IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    // 有効でない拡張機能は、何も許可されない
    if !matches!(entry.status, ExtensionStatus::Enabled { .. }) {
        return Ok(PermissionVerdictDto {
            verdict: "denied".to_owned(),
            warning: false,
        });
    }
    let verdict = rt
        .consent
        .lock()
        .map_err(lock_err)?
        .check(&entry, permission);
    Ok(match verdict {
        PermissionVerdict::Allowed => PermissionVerdictDto {
            verdict: "allowed".to_owned(),
            warning: false,
        },
        PermissionVerdict::NeedsConsent { warning } => PermissionVerdictDto {
            verdict: "needs_consent".to_owned(),
            warning,
        },
        PermissionVerdict::Denied => PermissionVerdictDto {
            verdict: "denied".to_owned(),
            warning: false,
        },
    })
}

pub fn dev_mode(rt: &ExtensionRuntime) -> Result<DevModeDto, IpcError> {
    let state = rt.state.lock().map_err(lock_err)?;
    Ok(DevModeDto {
        enabled: state.dev_mode(),
        folders: state
            .dev_folders()
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

pub fn set_dev_mode(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    enabled: bool,
) -> Result<(), IpcError> {
    rt.with_state(|s| {
        s.set_dev_mode(enabled);
        Ok(())
    })?;
    rt.dev_generation.fetch_add(1, Ordering::SeqCst);
    refresh(rt, serve, project)?;
    Ok(())
}

pub fn add_dev_folder(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    path: &str,
) -> Result<(), IpcError> {
    if !rt.state.lock().map_err(lock_err)?.dev_mode() {
        return Err(ExtensionError::DevModeOff.into());
    }
    rt.with_state(|s| {
        s.add_dev_folder(PathBuf::from(path));
        Ok(())
    })?;
    rt.dev_generation.fetch_add(1, Ordering::SeqCst);
    refresh(rt, serve, project)?;
    Ok(())
}

pub fn remove_dev_folder(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    path: &str,
) -> Result<(), IpcError> {
    rt.with_state(|s| {
        s.remove_dev_folder(std::path::Path::new(path));
        Ok(())
    })?;
    rt.dev_generation.fetch_add(1, Ordering::SeqCst);
    refresh(rt, serve, project)?;
    Ok(())
}

pub fn override_media_type(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    project: &ProjectState,
    extension: &str,
    media_type: Option<&str>,
) -> Result<(), IpcError> {
    rt.with_state(|s| s.set_media_override(extension, media_type))?;
    refresh(rt, serve, project)?;
    Ok(())
}

// ---- コマンド ----

fn changed(app: &tauri::AppHandle, reason: &str) {
    if let Err(error) = (ExtensionsChanged {
        reason: reason.to_owned(),
    })
    .emit(app)
    {
        tracing::warn!(%error, "extensions-changed を送れなかった");
    }
}

macro_rules! ctx {
    ($app:expr) => {{
        let rt = $app.state::<ExtensionRuntime>();
        let serve = $app.state::<ServeState>();
        let project = $app.state::<ProjectState>();
        (rt, serve, project)
    }};
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_install(
    app: tauri::AppHandle,
    path: String,
) -> Result<InstallOutcomeDto, IpcError> {
    let (rt, serve, project) = ctx!(app);
    let out = install(&rt, &serve, &project, &path)?;
    changed(&app, "install");
    Ok(out)
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_remove(
    app: tauri::AppHandle,
    id: String,
    version: Option<String>,
) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    remove(&rt, &serve, &project, &id, version.as_deref())?;
    changed(&app, "remove");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_list(
    rt: tauri::State<'_, ExtensionRuntime>,
    language: Option<String>,
) -> Vec<ExtensionEntryDto> {
    list(&rt, language.as_deref().unwrap_or("en"))
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_problems(rt: tauri::State<'_, ExtensionRuntime>) -> Vec<ProblemDto> {
    problems(&rt)
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_get(
    rt: tauri::State<'_, ExtensionRuntime>,
    id: String,
    language: Option<String>,
) -> Result<ExtensionDetailDto, IpcError> {
    detail(&rt, &id, language.as_deref().unwrap_or("en"))
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    set_enabled(&rt, &serve, &project, &id, enabled)?;
    changed(&app, "state");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_pin(
    app: tauri::AppHandle,
    id: String,
    version: Option<String>,
) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    pin(&rt, &serve, &project, &id, version.as_deref())?;
    changed(&app, "state");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_permissions(
    rt: tauri::State<'_, ExtensionRuntime>,
    id: String,
) -> Result<PermissionStateDto, IpcError> {
    permissions(&rt, &id)
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_consent(
    app: tauri::AppHandle,
    id: String,
    permissions: Vec<String>,
) -> Result<(), IpcError> {
    let rt = app.state::<ExtensionRuntime>();
    consent(&rt, &id, &permissions)?;
    let _ = PermissionsChanged { id }.emit(&app);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_revoke(
    app: tauri::AppHandle,
    id: String,
    permissions: Vec<String>,
) -> Result<(), IpcError> {
    let rt = app.state::<ExtensionRuntime>();
    revoke(&rt, &id, &permissions)?;
    let _ = PermissionsChanged { id }.emit(&app);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn extension_check_permission(
    rt: tauri::State<'_, ExtensionRuntime>,
    id: String,
    permission: String,
) -> Result<PermissionVerdictDto, IpcError> {
    check_permission(&rt, &id, &permission)
}

#[tauri::command(async)]
#[specta::specta]
pub fn devmode_get(rt: tauri::State<'_, ExtensionRuntime>) -> Result<DevModeDto, IpcError> {
    dev_mode(&rt)
}

#[tauri::command(async)]
#[specta::specta]
pub fn devmode_set(app: tauri::AppHandle, enabled: bool) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    set_dev_mode(&rt, &serve, &project, enabled)?;
    changed(&app, "dev");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn devmode_add_folder(app: tauri::AppHandle, path: String) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    add_dev_folder(&rt, &serve, &project, &path)?;
    changed(&app, "dev");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn devmode_remove_folder(app: tauri::AppHandle, path: String) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    remove_dev_folder(&rt, &serve, &project, &path)?;
    changed(&app, "dev");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn media_rules_override(
    app: tauri::AppHandle,
    extension: String,
    media_type: Option<String>,
) -> Result<(), IpcError> {
    let (rt, serve, project) = ctx!(app);
    override_media_type(&rt, &serve, &project, &extension, media_type.as_deref())?;
    changed(&app, "state");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn blob_dir(serve: tauri::State<'_, ServeState>) -> String {
    serve.blobs.dir().to_string_lossy().into_owned()
}

/// 開発中の `dist/` を見張る背景のスレッド。開発中のフォルダの組が変わったら、見張りを作り直す。
pub fn start_dev_watch(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut generation = u64::MAX;
        let mut watcher: Option<DevWatcher> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let rt = app.state::<ExtensionRuntime>();
            if rt.dev_generation() != generation {
                generation = rt.dev_generation();
                let folders = rt.dev_folders();
                watcher = (!folders.is_empty()).then(|| {
                    DevWatcher::new(&folders).unwrap_or_else(|_| DevWatcher::polling(&folders))
                });
            }
            let Some(watcher) = watcher.as_mut() else {
                continue;
            };
            for id in watcher.poll() {
                let (rt, serve, project) = ctx!(app);
                if let Err(error) = refresh(&rt, &serve, &project) {
                    tracing::warn!(code = %error.code, "開発中の拡張機能を読み直せなかった");
                }
                let _ = DevExtensionChanged { id }.emit(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_commands::{list as list_assets, scan};
    use crate::project_commands::{Hooks, open_project};
    use crate::unno_protocol::{UnnoRequest, handle};
    use unnotator_core::assets::scan::ScanScope;
    use unnotator_core::assets::{AssetFilter, Page};
    use unnotator_core::serve::{BlobStore, PreviewCache};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "unnotator-extipc-{}-{}-{n}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(path.join("project")).expect("作れる");
            std::fs::create_dir_all(path.join("data")).expect("作れる");
            std::fs::create_dir_all(path.join("cache")).expect("作れる");
            Self(path)
        }
        fn paths(&self) -> AppPaths {
            AppPaths::new(&self.0.join("data"), &self.0.join("cache"))
        }
        fn install_text_extension(&self, version: &str, permissions: &[&str]) {
            let dir = self
                .paths()
                .extension_dir("com.example.text", version)
                .expect("パス");
            std::fs::create_dir_all(dir.join("dist")).expect("作れる");
            let manifest = serde_json::json!({
                "id": "com.example.text", "version": version,
                "engines": { "unnotator": "^1.0.0" }, "main": "dist/index.js",
                "permissions": permissions,
                "contributes": { "mediaTypes": [
                    { "id": "text", "title": "t", "extensions": [".txt"], "mimeTypes": ["text/plain"] }
                ] }
            });
            std::fs::write(dir.join("unnotator-plugin.json"), manifest.to_string())
                .expect("書ける");
            std::fs::write(dir.join("dist/index.js"), "export {}").expect("書ける");
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn parts(temp: &Temp) -> (ExtensionRuntime, ServeState, ProjectState) {
        let serve = ServeState::new(
            BlobStore::open(temp.0.join("data/blobs")).expect("開ける"),
            PreviewCache::new(temp.0.join("cache/previews")),
        );
        let rt = ExtensionRuntime::new(temp.paths(), &serve);
        (rt, serve, ProjectState::new(temp.0.join("recovery")))
    }

    #[test]
    fn startup_finds_installed_extensions_and_feeds_the_open_project() {
        let temp = Temp::new();
        temp.install_text_extension("1.0.0", &["assets.read"]);
        std::fs::write(temp.0.join("project/a.txt"), b"hello").expect("書ける");
        let (rt, serve, project) = parts(&temp);
        let entries = list(&rt, "en");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            (entries[0].status.as_str(), entries[0].origin.as_str()),
            ("enabled", "installed")
        );

        open_project(&project, &temp.0.join("project"), true, Hooks::default()).expect("開ける");
        refresh(&rt, &serve, &project).expect("流し込める");
        scan(&project, ScanScope::Full, &|_| {}).expect("走査できる");
        let page = list_assets(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        assert_eq!(
            page.items[0].media_type.as_deref(),
            Some("com.example.text/text")
        );

        // 配信にも、宣言の Content-Type が使われる
        let path = format!("/asset/{}", page.items[0].id);
        let r = handle(
            &project,
            &serve,
            &UnnoRequest {
                method: "GET",
                path: &path,
                range: None,
                if_none_match: None,
            },
        );
        assert_eq!(r.header("content-type"), Some("text/plain"));

        // 無効にすると、不明に戻る。有効にすると、また付く
        set_enabled(&rt, &serve, &project, "com.example.text", false).expect("無効にできる");
        let page = list_assets(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        assert_eq!(page.items[0].media_type, None);
        assert_eq!(
            list(&rt, "en")[0].disabled_reason.as_deref(),
            Some("user_disabled")
        );
        set_enabled(&rt, &serve, &project, "com.example.text", true).expect("有効にできる");
        let page = list_assets(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        assert!(page.items[0].media_type.is_some());
    }

    #[test]
    fn consent_is_checked_per_extension_and_survives_a_restart() {
        let temp = Temp::new();
        temp.install_text_extension("1.0.0", &["assets.read", "network"]);
        let (rt, _serve, _project) = parts(&temp);
        let state = permissions(&rt, "com.example.text").expect("取れる");
        assert_eq!(state.pending.len(), 2);
        assert!(
            state
                .pending
                .iter()
                .any(|p| p.permission == "network" && p.warning)
        );
        assert_eq!(
            check_permission(&rt, "com.example.text", "assets.read")
                .expect("判定")
                .verdict,
            "needs_consent"
        );
        assert_eq!(
            check_permission(&rt, "com.example.text", "labels.write")
                .expect("判定")
                .verdict,
            "denied"
        );
        consent(&rt, "com.example.text", &["assets.read".to_owned()]).expect("同意できる");
        assert!(
            consent(&rt, "com.example.text", &["labels.write".to_owned()]).is_err(),
            "宣言に無い権限"
        );
        drop(rt);
        let (rt, _serve, _project) = parts(&temp);
        assert_eq!(
            check_permission(&rt, "com.example.text", "assets.read")
                .expect("判定")
                .verdict,
            "allowed"
        );
        assert!(check_permission(&rt, "com.example.ghost", "assets.read").is_err());
    }

    #[test]
    fn removing_an_extension_forgets_its_consent_and_old_staging_is_cleared() {
        let temp = Temp::new();
        temp.install_text_extension("1.0.0", &["assets.read"]);
        std::fs::create_dir_all(temp.paths().staging_dir().join("half")).expect("作れる");
        let (rt, serve, project) = parts(&temp);
        assert_eq!(
            std::fs::read_dir(temp.paths().staging_dir())
                .expect("ある")
                .count(),
            0,
            "起動時に片付く"
        );
        consent(&rt, "com.example.text", &["assets.read".to_owned()]).expect("同意");
        remove(&rt, &serve, &project, "com.example.text", None).expect("消せる");
        assert!(list(&rt, "en").is_empty());
        temp.install_text_extension("1.0.0", &["assets.read"]);
        refresh(&rt, &serve, &project).expect("読み直せる");
        assert_eq!(
            permissions(&rt, "com.example.text")
                .expect("取れる")
                .pending
                .len(),
            1,
            "古い同意は戻らない"
        );
    }

    #[test]
    fn dev_mode_gates_dev_folders_and_install_is_not_available_yet() {
        let temp = Temp::new();
        let (rt, serve, project) = parts(&temp);
        let dev = temp.0.join("dev-ext");
        std::fs::create_dir_all(dev.join("dist")).expect("作れる");
        std::fs::write(
            dev.join("unnotator-plugin.json"),
            r#"{"id":"com.example.dev","version":"0.1.0","engines":{"unnotator":"^1.0.0"},"main":"dist/index.js"}"#,
        )
        .expect("書ける");
        assert_eq!(
            add_dev_folder(&rt, &serve, &project, &dev.to_string_lossy())
                .unwrap_err()
                .code,
            "dev_mode_off"
        );
        set_dev_mode(&rt, &serve, &project, true).expect("オンにできる");
        add_dev_folder(&rt, &serve, &project, &dev.to_string_lossy()).expect("足せる");
        let entries = list(&rt, "en");
        assert_eq!(
            (entries[0].id.as_str(), entries[0].origin.as_str()),
            ("com.example.dev", "dev")
        );
        assert_eq!(dev_mode(&rt).expect("取れる").folders.len(), 1);
        set_dev_mode(&rt, &serve, &project, false).expect("オフにできる");
        assert!(list(&rt, "en").is_empty());
        assert!(dev.is_dir(), "フォルダは残る");
        assert_eq!(
            install(&rt, &serve, &project, "/nowhere.unnoplugin")
                .unwrap_err()
                .code,
            "package"
        );
    }
}
