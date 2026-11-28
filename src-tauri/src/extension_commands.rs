//! 拡張機能の IPC（contracts/ipc.md）。状態の保持と型の変換だけを行う薄い層。
//! 検証・解決・権限の中身は `unnotator-extensions` にある。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri_specta::Event;
use unnotator_core::command::Command;
use unnotator_core::event::ChangeSet;
use unnotator_extensions::ExtensionError;
use unnotator_extensions::consent::{ConsentStore, PermissionVerdict};
use unnotator_extensions::devmode::{DevWatcher, load_active_folders};
use unnotator_extensions::gate::{self, GateError};
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

impl From<GateError> for IpcError {
    fn from(error: GateError) -> Self {
        let code = match &error {
            GateError::NeedsConsent { .. } => "needs_consent",
            _ => "permission_denied",
        };
        Self {
            code: code.to_owned(),
            message: error.to_string(),
        }
    }
}

// --- 拡張機能向けの IPC（contracts/host-api-gate.md） ---
//
// 拡張機能 ID は、本体が枠の経路から決めて引数に付ける（拡張機能の指定ではない）。
// どの経路も、先に門（`gate`）を通し、通らなければ何も読まず・書かない。

/// Host API のメソッドを、この拡張機能が呼んでよいか。
pub fn ext_check_method(rt: &ExtensionRuntime, ext_id: &str, method: &str) -> Result<(), IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, ext_id)?;
    let consent = rt.consent.lock().map_err(lock_err)?;
    gate::check_method(&consent, &entry, method).map_err(IpcError::from)
}

/// 拡張機能から来たコマンドを検査し、`source` を拡張機能 ID に固定して返す。
/// `Transaction` は中身を 1 つずつ検査する（入れ子は開かない）。
pub fn authorize_command(
    rt: &ExtensionRuntime,
    ext_id: &str,
    mut command: Command,
) -> Result<Command, IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, ext_id)?;
    let consent = rt.consent.lock().map_err(lock_err)?;
    let check = |command: &Command| {
        gate::check_command(&consent, &entry, command.name()).map_err(IpcError::from)
    };
    match &mut command {
        Command::Transaction { commands } => {
            for inner in commands.iter_mut() {
                if matches!(inner, Command::Transaction { .. }) {
                    return Err(GateError::NotOpen("transaction".to_owned()).into());
                }
                check(inner)?;
                pin_source(inner, ext_id);
            }
        }
        other => {
            check(other)?;
            pin_source(other, ext_id);
        }
    }
    Ok(command)
}

/// 作成系の `source` を、拡張機能 ID に上書きする（`manual` や他の ID は名乗れない）。
fn pin_source(command: &mut Command, ext_id: &str) {
    match command {
        Command::CreateAnnotation { source, .. }
        | Command::CreateRelation { source, .. }
        | Command::CreateGroup { source, .. } => *source = Some(ext_id.to_owned()),
        // メタ情報の名前空間は、呼び出した拡張機能の ID に固定する（他の拡張機能の領域には書けない）。
        Command::SetAssetMetadata { namespace, .. }
        | Command::SetItemMetadata { namespace, .. } => {
            *namespace = ext_id.to_owned();
        }
        _ => {}
    }
}

/// 拡張機能のコマンドを適用する。`apply_command` と同じ経路（Undo・変更履歴に乗る）。
pub fn ext_apply(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    command: Command,
) -> Result<ChangeSet, IpcError> {
    let command = authorize_command(rt, ext_id, command)?;
    crate::project_commands::apply(project, command)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_apply_command(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    command: Command,
) -> Result<ChangeSet, IpcError> {
    ext_apply(&rt, &project, &ext_id, command)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_method_allowed(
    rt: tauri::State<'_, ExtensionRuntime>,
    ext_id: String,
    method: String,
) -> Result<(), IpcError> {
    ext_check_method(&rt, &ext_id, &method)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_labels_list(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
) -> Result<Vec<unnotator_core::query::labels::LabelRow>, IpcError> {
    ext_check_method(&rt, &ext_id, "labels.list")?;
    crate::query_commands::labels(&project)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_schemas_list(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
) -> Result<Vec<unnotator_core::query::schemas::SchemaRow>, IpcError> {
    ext_check_method(&rt, &ext_id, "labels.attributeSchema")?;
    crate::query_commands::schemas(&project)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_asset_get(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    asset_id: String,
) -> Result<Option<unnotator_core::query::ext::ExtAsset>, IpcError> {
    ext_check_method(&rt, &ext_id, "assets.get")?;
    crate::project_commands::with_store(&project, |store| store.ext_asset(&asset_id))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_item_get(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    asset_id: String,
    item_key: String,
) -> Result<Option<unnotator_core::query::ext::ExtItem>, IpcError> {
    ext_check_method(&rt, &ext_id, "assets.getItem")?;
    crate::project_commands::with_store(&project, |store| store.ext_item(&asset_id, &item_key))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_annotations_query(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    filter: unnotator_core::query::ext::ExtAnnotationFilter,
) -> Result<Vec<unnotator_core::query::ext::ExtAnnotation>, IpcError> {
    ext_annotations(&rt, &project, &ext_id, &filter)
}

/// アノテーションの問い合わせ（`selector` を含む）。先に権限の門を通す。
pub fn ext_annotations(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    filter: &unnotator_core::query::ext::ExtAnnotationFilter,
) -> Result<Vec<unnotator_core::query::ext::ExtAnnotation>, IpcError> {
    ext_check_method(rt, ext_id, "annotations.query")?;
    crate::project_commands::with_store(project, |store| store.ext_annotations(filter))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_relations_query(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    filter: unnotator_core::query::ext::ExtRelationFilter,
) -> Result<Vec<unnotator_core::query::ext::ExtRelation>, IpcError> {
    ext_check_method(&rt, &ext_id, "relations.query")?;
    crate::project_commands::with_store(&project, |store| store.ext_relations(&filter))
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_groups_query(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    filter: unnotator_core::query::ext::ExtGroupFilter,
) -> Result<Vec<unnotator_core::query::ext::ExtGroup>, IpcError> {
    ext_check_method(&rt, &ext_id, "groups.query")?;
    crate::project_commands::with_store(&project, |store| store.ext_groups(&filter))
}

/// 1 回に読めるバイト数の上限（IPC の応答を大きくしすぎない。続きは `offset` を進めて呼ぶ）。
pub const MAX_ASSET_READ_BYTES: u64 = 1024 * 1024;

/// アセットの実体の範囲を読む。範囲が上限を超えるときは、上限までを返す（呼び出し側が続きを読む）。
pub fn read_asset_range(
    file: &unnotator_core::serve::AssetFile,
    offset: u64,
    length: Option<u64>,
) -> Result<Vec<u8>, IpcError> {
    use std::io::{Read, Seek, SeekFrom};
    let io_err = |error: std::io::Error| IpcError {
        code: "io".to_owned(),
        message: error.to_string(),
    };
    let path = file.root.join(&file.rel_path);
    let mut handle = std::fs::File::open(path).map_err(io_err)?;
    let total = handle.metadata().map_err(io_err)?.len();
    if offset >= total {
        return Ok(Vec::new());
    }
    let wanted = length.unwrap_or(u64::MAX).min(total - offset);
    let count = wanted.min(MAX_ASSET_READ_BYTES);
    handle.seek(SeekFrom::Start(offset)).map_err(io_err)?;
    let mut buffer = Vec::new();
    handle
        .take(count)
        .read_to_end(&mut buffer)
        .map_err(io_err)?;
    Ok(buffer)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_asset_read(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    asset_id: String,
    offset: f64,
    length: Option<f64>,
) -> Result<Vec<u8>, IpcError> {
    ext_asset_bytes(&rt, &project, &ext_id, &asset_id, offset, length)
}

/// アセットの実体の範囲（`assets.read`）。先に権限の門を通す。
pub fn ext_asset_bytes(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    asset_id: &str,
    offset: f64,
    length: Option<f64>,
) -> Result<Vec<u8>, IpcError> {
    ext_check_method(rt, ext_id, "assets.read")?;
    let file = crate::project_commands::with_store(project, |store| {
        store
            .asset_file(asset_id)
            .map_err(|_| unnotator_core::error::StoreError::NotFound(asset_id.to_owned()))
    })?;
    // JS の number は 2^53 まで正確。負・非数は 0 として扱う。
    let to_u64 = |value: f64| {
        if value.is_finite() && value > 0.0 {
            value as u64
        } else {
            0
        }
    };
    read_asset_range(&file, to_u64(offset), length.map(to_u64))
}

/// `host.storage.get`。自分の名前空間だけを読む（`plugin_id` は `ext_id` に固定）。
pub fn ext_storage_value(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    scope: unnotator_core::command::PluginScope,
    scope_id: &str,
    key: &str,
) -> Result<Option<String>, IpcError> {
    ext_check_method(rt, ext_id, "storage.get")?;
    crate::project_commands::with_store(project, |store| {
        store.plugin_value(ext_id, scope, scope_id, key)
    })
}

/// `host.storage.set`。書き込みは `apply_command` の経路（Undo には積まない）。
pub fn ext_storage_write(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    scope: unnotator_core::command::PluginScope,
    scope_id: &str,
    key: &str,
    value_json: &str,
) -> Result<(), IpcError> {
    ext_check_method(rt, ext_id, "storage.set")?;
    crate::project_commands::apply(
        project,
        Command::SetPluginData {
            plugin_id: ext_id.to_owned(),
            scope,
            scope_id: scope_id.to_owned(),
            key: key.to_owned(),
            value_json: value_json.to_owned(),
        },
    )
    .map(|_| ())
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_storage_get(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    scope: unnotator_core::command::PluginScope,
    scope_id: String,
    key: String,
) -> Result<Option<String>, IpcError> {
    ext_storage_value(&rt, &project, &ext_id, scope, &scope_id, &key)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_storage_set(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    scope: unnotator_core::command::PluginScope,
    scope_id: String,
    key: String,
    value_json: String,
) -> Result<(), IpcError> {
    ext_storage_write(&rt, &project, &ext_id, scope, &scope_id, &key, &value_json)
}

/// `host.projectFiles` の 1 回の書き込みの大きさの上限（バイト）。
pub const MAX_PROJECT_FILE_BYTES: usize = 16 * 1024 * 1024;

/// `.unnotator/plugins/<ext_id>/` の中の `rel_path` の場所。`..`・絶対パス・区切りの違い・空の成分は拒否する。
pub fn plugin_file_path(
    project_folder: &std::path::Path,
    ext_id: &str,
    rel_path: &str,
) -> Result<PathBuf, IpcError> {
    let bad = |message: &str| IpcError {
        code: "invalid_command".to_owned(),
        message: message.to_owned(),
    };
    if ext_id.is_empty() || ext_id.contains(['/', '\\', '\0']) || ext_id == "." || ext_id == ".." {
        return Err(bad("拡張機能 ID が使えません"));
    }
    if rel_path.is_empty()
        || rel_path.len() > 1024
        || rel_path.contains(['\\', '\0', ':'])
        || rel_path.starts_with('/')
    {
        return Err(bad("パスが使えません"));
    }
    let mut path = project_folder
        .join(".unnotator")
        .join("plugins")
        .join(ext_id);
    for part in rel_path.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.len() > 255 {
            return Err(bad("パスが使えません"));
        }
        path.push(part);
    }
    Ok(path)
}

/// 書く先が、すでにある領域の外へ出ていない（シンボリックリンクで抜けない）ことを確かめる。
fn inside_plugin_dir(base: &std::path::Path, target: &std::path::Path) -> bool {
    let Ok(base) = base.canonicalize() else {
        return true; // まだ無い領域は、これから作る
    };
    let mut probe = target.to_path_buf();
    // 無いところは、いちばん近い親で確かめる。
    while !probe.exists() {
        if !probe.pop() {
            return false;
        }
    }
    probe
        .canonicalize()
        .is_ok_and(|real| real.starts_with(base))
}

pub fn ext_project_file_bytes(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    rel_path: &str,
) -> Result<Option<Vec<u8>>, IpcError> {
    ext_check_method(rt, ext_id, "projectFiles.read")?;
    let folder =
        crate::project_commands::with_store(project, |store| Ok(store.folder().to_path_buf()))?;
    let path = plugin_file_path(&folder, ext_id, rel_path)?;
    let base = folder.join(".unnotator").join("plugins").join(ext_id);
    if !inside_plugin_dir(&base, &path) {
        return Err(IpcError {
            code: "permission_denied".to_owned(),
            message: "領域の外です".to_owned(),
        });
    }
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(IpcError {
            code: "io".to_owned(),
            message: error.to_string(),
        }),
    }
}

pub fn ext_project_file_put(
    rt: &ExtensionRuntime,
    project: &ProjectState,
    ext_id: &str,
    rel_path: &str,
    data: &[u8],
) -> Result<(), IpcError> {
    ext_check_method(rt, ext_id, "projectFiles.write")?;
    if data.len() > MAX_PROJECT_FILE_BYTES {
        return Err(IpcError {
            code: "invalid_command".to_owned(),
            message: "ファイルが大きすぎます".to_owned(),
        });
    }
    let folder =
        crate::project_commands::with_store(project, |store| Ok(store.folder().to_path_buf()))?;
    let path = plugin_file_path(&folder, ext_id, rel_path)?;
    let base = folder.join(".unnotator").join("plugins").join(ext_id);
    if !inside_plugin_dir(&base, &path) {
        return Err(IpcError {
            code: "permission_denied".to_owned(),
            message: "領域の外です".to_owned(),
        });
    }
    unnotator_core::fsio::atomic_write(&path, data, None).map_err(IpcError::from)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_project_file_read(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    rel_path: String,
) -> Result<Option<Vec<u8>>, IpcError> {
    ext_project_file_bytes(&rt, &project, &ext_id, &rel_path)
}

#[tauri::command(async)]
#[specta::specta]
pub fn ext_project_file_write(
    rt: tauri::State<'_, ExtensionRuntime>,
    project: tauri::State<'_, ProjectState>,
    ext_id: String,
    rel_path: String,
    data: Vec<u8>,
) -> Result<(), IpcError> {
    ext_project_file_put(&rt, &project, &ext_id, &rel_path, &data)
}

/// `host.log`。拡張機能 ID つきで `tracing` に記録する。長さは呼び出し側（本体）が制限済みだが、ここでも切る。
#[tauri::command(async)]
#[specta::specta]
pub fn ext_log(
    rt: tauri::State<'_, ExtensionRuntime>,
    ext_id: String,
    level: String,
    message: String,
) -> Result<(), IpcError> {
    ext_check_method(&rt, &ext_id, "log")?;
    let message: String = message.chars().take(2000).collect();
    match level.as_str() {
        "debug" => tracing::debug!(extension = %ext_id, "{message}"),
        "warn" => tracing::warn!(extension = %ext_id, "{message}"),
        "error" => tracing::error!(extension = %ext_id, "{message}"),
        _ => tracing::info!(extension = %ext_id, "{message}"),
    }
    Ok(())
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
        self.sync_grants(serve);
        Ok(registry)
    }

    /// 導入済みの拡張機能のメディアの判定規則を、開いているプロジェクトへ流し込む。
    /// 登録簿が変わったとき（`refresh`）に加えて、プロジェクトを開いたときにも要る
    /// （開いたプロジェクトは、規則が空の状態から始まるため）。開いていなければ何もしない。
    pub fn apply_media_rules(&self, project: &ProjectState) -> Result<(), IpcError> {
        let registry = self.registry();
        let state = self.state.lock().map_err(lock_err)?.clone();
        match set_rules(project, registry.media_rules(&state)) {
            Ok(_) => Ok(()),
            Err(e) if e.code == "not_open" => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// 有効な拡張機能ごとの、宣言していて同意済みの権限を、配信の CSP の元に渡す。
    /// 登録簿の作り直し・同意・取り消しのたびに呼ぶ（未設定の間は「権限なし」で安全側）。
    pub fn sync_grants(&self, serve: &ServeState) {
        let registry = self.registry();
        let Ok(consent) = self.consent.lock() else {
            return;
        };
        let grants = registry
            .extensions()
            .iter()
            .filter(|e| matches!(e.status, ExtensionStatus::Enabled { .. }))
            .map(|e| {
                let granted = e
                    .manifest
                    .permissions
                    .iter()
                    .filter(|p| matches!(consent.check(e, p), PermissionVerdict::Allowed))
                    .cloned()
                    .collect::<Vec<_>>();
                (e.manifest.id.clone(), granted)
            })
            .collect();
        serve.set_ext_grants(grants);
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

pub fn consent(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    id: &str,
    permissions: &[String],
) -> Result<(), IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    rt.consent
        .lock()
        .map_err(lock_err)?
        .grant(&entry, permissions)?;
    rt.sync_grants(serve);
    Ok(())
}

pub fn revoke(
    rt: &ExtensionRuntime,
    serve: &ServeState,
    id: &str,
    permissions: &[String],
) -> Result<(), IpcError> {
    let registry = rt.registry();
    let entry = find_entry(&registry, id)?;
    rt.consent
        .lock()
        .map_err(lock_err)?
        .revoke(id, &entry.version, permissions)?;
    rt.sync_grants(serve);
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
    let serve = app.state::<ServeState>();
    consent(&rt, &serve, &id, &permissions)?;
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
    let serve = app.state::<ServeState>();
    revoke(&rt, &serve, &id, &permissions)?;
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
                "engines": { "unnotator": "^0.0.1" }, "main": "dist/index.js",
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
    fn opening_a_project_applies_the_installed_media_rules_without_a_registry_refresh() {
        // 判定規則は、登録簿の変更（`refresh`）だけでなく、プロジェクトを開いたときにも流し込む。
        let temp = Temp::new();
        temp.install_text_extension("1.0.0", &["assets.read"]);
        std::fs::write(temp.0.join("project/a.txt"), b"hello").expect("書ける");
        let (rt, _serve, project) = parts(&temp);
        open_project(&project, &temp.0.join("project"), true, Hooks::default()).expect("開ける");
        rt.apply_media_rules(&project).expect("流し込める");
        scan(&project, ScanScope::Full, &|_| {}).expect("走査できる");
        let page = list_assets(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        assert_eq!(
            page.items[0].media_type.as_deref(),
            Some("com.example.text/text")
        );
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
    fn consent_and_revoke_update_the_granted_permissions_used_for_the_frame_csp() {
        let temp = Temp::new();
        temp.install_text_extension("1.0.0", &["assets.read", "network"]);
        let (rt, serve, _project) = parts(&temp);
        assert!(
            serve.ext_grants_of("com.example.text").is_empty(),
            "同意前は権限なし"
        );
        consent(&rt, &serve, "com.example.text", &["assets.read".to_owned()]).expect("同意できる");
        assert_eq!(serve.ext_grants_of("com.example.text"), vec!["assets.read"]);
        revoke(&rt, &serve, "com.example.text", &["assets.read".to_owned()]).expect("取り消せる");
        assert!(
            serve.ext_grants_of("com.example.text").is_empty(),
            "取り消し後は権限なし"
        );
    }

    #[test]
    fn consent_is_checked_per_extension_and_survives_a_restart() {
        let temp = Temp::new();
        temp.install_text_extension("1.0.0", &["assets.read", "network"]);
        let (rt, serve, _project) = parts(&temp);
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
        consent(&rt, &serve, "com.example.text", &["assets.read".to_owned()]).expect("同意できる");
        assert!(
            consent(
                &rt,
                &serve,
                "com.example.text",
                &["labels.write".to_owned()]
            )
            .is_err(),
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
        consent(&rt, &serve, "com.example.text", &["assets.read".to_owned()]).expect("同意");
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
    fn dev_mode_gates_dev_folders_and_install_reports_bad_packages() {
        let temp = Temp::new();
        let (rt, serve, project) = parts(&temp);
        let dev = temp.0.join("dev-ext");
        std::fs::create_dir_all(dev.join("dist")).expect("作れる");
        std::fs::write(
            dev.join("unnotator-plugin.json"),
            r#"{"id":"com.example.dev","version":"0.1.0","engines":{"unnotator":"^0.0.1"},"main":"dist/index.js"}"#,
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
            "io"
        );
        let bad = temp.0.join("bad.unnoplugin");
        std::fs::write(&bad, b"not a zip").expect("書ける");
        assert_eq!(
            install(&rt, &serve, &project, &bad.to_string_lossy())
                .unwrap_err()
                .code,
            "package"
        );
    }

    // --- 拡張機能向けの IPC（T014。権限の門と `source` の固定） ---

    fn create_annotation(asset_id: &str, source: Option<&str>) -> Command {
        Command::CreateAnnotation {
            id: None,
            target: unnotator_core::command::Target {
                asset_id: asset_id.to_owned(),
                item: None,
            },
            annotation_type: "com.example.text/span".to_owned(),
            type_version: None,
            selector_json: "{}".to_owned(),
            label_id: None,
            attributes_json: None,
            summary: None,
            z_order: None,
            source: source.map(str::to_owned),
        }
    }

    fn create_label(name: &str) -> Command {
        Command::CreateLabel {
            id: None,
            name: name.to_owned(),
            name_i18n_json: None,
            color: "#112233".to_owned(),
            hotkey: None,
            sort_order: None,
            hidden: None,
            applies_to_json: None,
        }
    }

    /// 宣言と同意を整えた状態で、拡張機能・開いたプロジェクト・アセットを返す。
    fn ready(
        temp: &Temp,
        declared: &[&str],
        granted: &[&str],
    ) -> (ExtensionRuntime, ProjectState, String) {
        temp.install_text_extension("1.0.0", declared);
        std::fs::write(temp.0.join("project/a.txt"), b"hello").expect("書ける");
        let (rt, serve, project) = parts(temp);
        let granted: Vec<String> = granted.iter().map(|p| (*p).to_owned()).collect();
        consent(&rt, &serve, "com.example.text", &granted).expect("同意できる");
        open_project(&project, &temp.0.join("project"), true, Hooks::default()).expect("開ける");
        refresh(&rt, &serve, &project).expect("流し込める");
        scan(&project, ScanScope::Full, &|_| {}).expect("走査できる");
        let page = list_assets(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        (rt, project, page.items[0].id.clone())
    }

    #[test]
    fn ext_commands_are_refused_without_declaration_or_consent() {
        let temp = Temp::new();
        let (rt, project, asset) = ready(
            &temp,
            &["annotations.write", "labels.write"],
            &["annotations.write"],
        );
        // 同意のある権限は通る
        ext_apply(
            &rt,
            &project,
            "com.example.text",
            create_annotation(&asset, None),
        )
        .expect("通る");
        // 宣言していて同意が無い
        assert_eq!(
            ext_apply(&rt, &project, "com.example.text", create_label("a"))
                .unwrap_err()
                .code,
            "needs_consent"
        );
        // 宣言していない
        let status = Command::SetAssetStatus {
            asset_id: asset.clone(),
            status: unnotator_core::command::Status::Done,
        };
        assert_eq!(
            ext_apply(&rt, &project, "com.example.text", status)
                .unwrap_err()
                .code,
            "permission_denied"
        );
        // 知らない拡張機能
        assert_eq!(
            ext_apply(&rt, &project, "com.example.ghost", create_label("b"))
                .unwrap_err()
                .code,
            "not_found"
        );
        // 拒否されたものは、何も書かない
        assert_eq!(
            ext_check_method(&rt, "com.example.text", "labels.list")
                .unwrap_err()
                .code,
            "permission_denied"
        );
    }

    #[test]
    fn ext_commands_never_open_core_only_commands() {
        let temp = Temp::new();
        let all = ["annotations.write", "labels.write", "project.status"];
        let (rt, project, asset) = ready(&temp, &all, &all);
        for command in [
            Command::DeleteAsset {
                asset_id: asset.clone(),
            },
            Command::SetAssetNote {
                asset_id: asset.clone(),
                note: None,
            },
            Command::SyncAssets {
                added: vec![],
                updated: vec![],
                went_missing: vec![],
                restored: vec![],
                reclassified: vec![],
            },
        ] {
            assert_eq!(
                ext_apply(&rt, &project, "com.example.text", command)
                    .unwrap_err()
                    .code,
                "permission_denied"
            );
        }
        // 入れ子の Transaction も開かない
        let nested = Command::Transaction {
            commands: vec![Command::Transaction { commands: vec![] }],
        };
        assert_eq!(
            ext_apply(&rt, &project, "com.example.text", nested)
                .unwrap_err()
                .code,
            "permission_denied"
        );
        // Transaction の中の 1 つでも通らなければ、全体を書かない
        let mixed = Command::Transaction {
            commands: vec![create_label("ok"), Command::DeleteAsset { asset_id: asset }],
        };
        assert!(ext_apply(&rt, &project, "com.example.text", mixed).is_err());
        assert!(
            crate::query_commands::labels(&project)
                .expect("一覧")
                .is_empty()
        );
    }

    #[test]
    fn ext_commands_pin_the_source_to_the_extension_id() {
        for requested in [None, Some("manual"), Some("com.example.other")] {
            let temp = Temp::new();
            let (rt, _project, asset) =
                ready(&temp, &["annotations.write"], &["annotations.write"]);
            let fixed = authorize_command(
                &rt,
                "com.example.text",
                create_annotation(&asset, requested),
            )
            .expect("通る");
            assert_eq!(fixed.source(), Some("com.example.text"), "{requested:?}");
        }
        // Transaction の中の作成も固定する
        let temp = Temp::new();
        let (rt, _project, asset) = ready(&temp, &["annotations.write"], &["annotations.write"]);
        let tx = Command::Transaction {
            commands: vec![
                create_annotation(&asset, Some("manual")),
                create_annotation(&asset, None),
            ],
        };
        let Command::Transaction { commands } =
            authorize_command(&rt, "com.example.text", tx).expect("通る")
        else {
            panic!("Transaction のまま");
        };
        assert!(
            commands
                .iter()
                .all(|c| c.source() == Some("com.example.text"))
        );
    }

    #[test]
    fn ext_writes_go_through_apply_and_round_trip_with_undo_and_redo() {
        let temp = Temp::new();
        let (rt, project, asset) = ready(&temp, &["annotations.write"], &["annotations.write"]);
        let page = |project: &ProjectState| {
            crate::query_commands::page(project, &asset, None, None)
                .expect("一覧")
                .rows
        };
        // 拡張機能が `manual` を名乗っても、`source` は ID になる
        ext_apply(
            &rt,
            &project,
            "com.example.text",
            create_annotation(&asset, Some("manual")),
        )
        .expect("作れる");
        let created = page(&project);
        assert_eq!(created.len(), 1);
        assert_eq!(created[0].source, "com.example.text");
        // apply → undo → redo で一致する
        crate::project_commands::undo_project(&project).expect("戻せる");
        assert!(page(&project).is_empty());
        crate::project_commands::redo_project(&project).expect("やり直せる");
        assert_eq!(page(&project), created);
    }

    #[test]
    fn ext_reads_are_gated_and_return_selector_and_bytes() {
        let temp = Temp::new();
        let (rt, project, asset) = ready(
            &temp,
            &["annotations.write", "annotations.read", "assets.read"],
            &["annotations.write", "annotations.read"],
        );
        let id = "com.example.text";
        ext_apply(&rt, &project, id, create_annotation(&asset, None)).expect("作れる");
        let filter = unnotator_core::query::ext::ExtAnnotationFilter::default();
        let rows = ext_annotations(&rt, &project, id, &filter).expect("読める");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, id);
        assert!(!rows[0].selector_json.is_empty());
        // 同意の無い読み取りは、何も返さない
        assert_eq!(
            ext_asset_bytes(&rt, &project, id, &asset, 0.0, None)
                .unwrap_err()
                .code,
            "needs_consent"
        );
        // 宣言の無い拡張機能は、読み取りも拒否される
        assert_eq!(
            ext_annotations(&rt, &project, "com.example.ghost", &filter)
                .unwrap_err()
                .code,
            "not_found"
        );
    }

    #[test]
    fn asset_bytes_respect_range_and_the_per_call_cap() {
        let temp = Temp::new();
        let (rt, project, asset) = ready(&temp, &["assets.read"], &["assets.read"]);
        let id = "com.example.text";
        let all = ext_asset_bytes(&rt, &project, id, &asset, 0.0, None).expect("読める");
        assert_eq!(all, b"hello");
        let middle = ext_asset_bytes(&rt, &project, id, &asset, 1.0, Some(3.0)).expect("読める");
        assert_eq!(middle, b"ell");
        // 終わりを超える範囲は、あるところまで。始めが終わりを超えれば空
        let tail = ext_asset_bytes(&rt, &project, id, &asset, 3.0, Some(100.0)).expect("読める");
        assert_eq!(tail, b"lo");
        assert!(
            ext_asset_bytes(&rt, &project, id, &asset, 99.0, None)
                .expect("読める")
                .is_empty()
        );
        // 負・非数は 0 として扱う
        assert_eq!(
            ext_asset_bytes(&rt, &project, id, &asset, -5.0, Some(f64::NAN)).expect("読める"),
            b""
        );
        // 1 回の上限
        let big = temp.0.join("project/big.bin");
        std::fs::write(&big, vec![7u8; (MAX_ASSET_READ_BYTES as usize) + 10]).expect("書ける");
        let file = unnotator_core::serve::AssetFile {
            root: temp.0.join("project"),
            rel_path: "big.bin".to_owned(),
            size: 0,
            mtime_ms: 0,
        };
        let chunk = read_asset_range(&file, 0, None).expect("読める");
        assert_eq!(chunk.len() as u64, MAX_ASSET_READ_BYTES);
    }

    fn metadata_of(project: &ProjectState, asset: &str) -> serde_json::Value {
        let row = crate::project_commands::with_store(project, |store| store.ext_asset(asset))
            .expect("読める")
            .expect("ある");
        serde_json::from_str(&row.metadata_json).expect("JSON")
    }

    #[test]
    fn ext_metadata_is_pinned_to_the_extension_namespace_and_round_trips() {
        let temp = Temp::new();
        let (rt, project, asset) = ready(&temp, &["assets.metadata"], &["assets.metadata"]);
        let id = "com.example.text";
        // 他の拡張機能の名前空間を名乗っても、自分の名前空間に書かれる
        ext_apply(
            &rt,
            &project,
            id,
            Command::SetAssetMetadata {
                asset_id: asset.clone(),
                namespace: "com.example.other".to_owned(),
                metadata_json: r#"{"w":1}"#.to_owned(),
            },
        )
        .expect("書ける");
        assert_eq!(
            metadata_of(&project, &asset),
            serde_json::json!({"com.example.text": {"w": 1}})
        );
        // apply → undo → redo で一致する
        crate::project_commands::undo_project(&project).expect("戻せる");
        assert_eq!(metadata_of(&project, &asset), serde_json::json!({}));
        crate::project_commands::redo_project(&project).expect("やり直せる");
        assert_eq!(
            metadata_of(&project, &asset),
            serde_json::json!({"com.example.text": {"w": 1}})
        );
    }

    #[test]
    fn ext_transaction_is_one_undo_and_a_failure_leaves_nothing() {
        let temp = Temp::new();
        let (rt, project, asset) = ready(
            &temp,
            &["annotations.write", "annotations.read", "assets.metadata"],
            &["annotations.write", "annotations.read", "assets.metadata"],
        );
        let id = "com.example.text";
        let count = |project: &ProjectState| {
            ext_annotations(
                &rt,
                project,
                id,
                &unnotator_core::query::ext::ExtAnnotationFilter::default(),
            )
            .expect("読める")
            .len()
        };
        let metadata = |value: &str| Command::SetAssetMetadata {
            asset_id: asset.clone(),
            namespace: id.to_owned(),
            metadata_json: value.to_owned(),
        };
        // 成功: 3 つの操作が 1 回の Undo になる
        ext_apply(
            &rt,
            &project,
            id,
            Command::Transaction {
                commands: vec![
                    create_annotation(&asset, None),
                    create_annotation(&asset, Some("manual")),
                    metadata(r#"{"k":1}"#),
                ],
            },
        )
        .expect("通る");
        assert_eq!(count(&project), 2);
        crate::project_commands::undo_project(&project).expect("戻せる");
        assert_eq!(count(&project), 0);
        assert_eq!(metadata_of(&project, &asset), serde_json::json!({}));
        crate::project_commands::redo_project(&project).expect("やり直せる");
        assert_eq!(count(&project), 2);
        // 途中の失敗（存在しないアセット）では、何も残さない
        let failing = ext_apply(
            &rt,
            &project,
            id,
            Command::Transaction {
                commands: vec![
                    create_annotation(&asset, None),
                    create_annotation("no-such-asset", None),
                ],
            },
        );
        assert!(failing.is_err());
        assert_eq!(count(&project), 2);
        // 入れ子は開かない
        let nested = ext_apply(
            &rt,
            &project,
            id,
            Command::Transaction {
                commands: vec![Command::Transaction { commands: vec![] }],
            },
        );
        assert!(nested.is_err());
    }

    #[test]
    fn ext_storage_is_scoped_to_the_extension_and_counts_as_unsaved() {
        use unnotator_core::command::PluginScope;
        let temp = Temp::new();
        let (rt, project, _asset) = ready(&temp, &[], &[]);
        let id = "com.example.text";
        ext_storage_write(
            &rt,
            &project,
            id,
            PluginScope::Project,
            "",
            "k",
            "{\"a\":1}",
        )
        .expect("書ける");
        assert_eq!(
            ext_storage_value(&rt, &project, id, PluginScope::Project, "", "k").expect("読める"),
            Some("{\"a\":1}".to_owned())
        );
        // 保存の対象になる
        let state =
            crate::project_commands::with_store(&project, |s| Ok(s.save_state())).expect("状態");
        assert!(state.dirty);
        // 知らない拡張機能は読み書きできない
        assert_eq!(
            ext_storage_write(
                &rt,
                &project,
                "com.example.ghost",
                PluginScope::Project,
                "",
                "k",
                "1"
            )
            .unwrap_err()
            .code,
            "not_found"
        );
        // ext_apply_command からは書けない（専用の IPC だけ）
        let direct = Command::SetPluginData {
            plugin_id: "com.example.other".to_owned(),
            scope: PluginScope::Project,
            scope_id: String::new(),
            key: "k".to_owned(),
            value_json: "1".to_owned(),
        };
        assert_eq!(
            ext_apply(&rt, &project, id, direct).unwrap_err().code,
            "permission_denied"
        );
    }

    #[test]
    fn project_files_stay_inside_the_extension_directory() {
        let temp = Temp::new();
        let (rt, project, _asset) = ready(&temp, &["project.files"], &["project.files"]);
        let id = "com.example.text";
        ext_project_file_put(&rt, &project, id, "notes/a.txt", b"hello").expect("書ける");
        assert_eq!(
            ext_project_file_bytes(&rt, &project, id, "notes/a.txt").expect("読める"),
            Some(b"hello".to_vec())
        );
        assert_eq!(
            ext_project_file_bytes(&rt, &project, id, "none.txt").expect("読める"),
            None
        );
        for bad in [
            "../x",
            "/abs",
            "a/../../b",
            "a//b",
            "",
            "C:/x",
            "a\\b",
            "./a",
        ] {
            assert!(
                ext_project_file_put(&rt, &project, id, bad, b"x").is_err(),
                "{bad}"
            );
            assert!(
                ext_project_file_bytes(&rt, &project, id, bad).is_err(),
                "{bad}"
            );
        }
        // 他の拡張機能の領域には、書いた場所が入らない
        let other = temp
            .0
            .join("project/.unnotator/plugins/com.example.other/notes/a.txt");
        assert!(!other.exists());
        assert!(
            temp.0
                .join("project/.unnotator/plugins/com.example.text/notes/a.txt")
                .exists()
        );
    }

    #[test]
    fn project_files_need_the_permission() {
        let temp = Temp::new();
        let (rt, project, _asset) = ready(&temp, &["project.files"], &[]);
        assert_eq!(
            ext_project_file_put(&rt, &project, "com.example.text", "a.txt", b"x")
                .unwrap_err()
                .code,
            "needs_consent"
        );
    }

    #[test]
    fn project_file_paths_are_resolved_without_touching_the_disk() {
        let base = std::path::Path::new("/p");
        let ok = plugin_file_path(base, "com.example.text", "a/b.txt").expect("通る");
        assert!(ok.ends_with("plugins/com.example.text/a/b.txt"));
        assert!(plugin_file_path(base, "../evil", "a").is_err());
        assert!(plugin_file_path(base, "a/b", "a").is_err());
    }
}
