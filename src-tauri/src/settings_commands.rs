//! 設定の IPC コマンド（contracts/ipc.md）。値は JSON のテキストで受け渡す。
//! プロジェクトを開いているときはストア（2 段）を通し、開いていないときはユーザー設定だけを直接扱う。

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use unnotator_core::error::StoreError;
use unnotator_core::settings::keys::{CORE_KEYS, CoreKey};
use unnotator_core::settings::{Layer, Settings, SettingsChanged, SettingsIssue, Source};

use crate::project_commands::{IpcError, ProjectState, with_store};

/// 設定の実効値と、どの段のものか。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct EffectiveSetting {
    pub value_json: String,
    pub source: Source,
}

fn parse(value_json: &str) -> Result<serde_json::Value, IpcError> {
    serde_json::from_str(value_json).map_err(|error| {
        IpcError::from(StoreError::InvalidCommand(format!(
            "値が JSON として読めない: {error}"
        )))
    })
}

fn json_text(value: &serde_json::Value) -> String {
    value.to_string()
}

/// プロジェクトを開いていないとき、ユーザー設定だけを扱う窓口。
fn user_only(state: &ProjectState) -> Result<Settings, IpcError> {
    state
        .user_settings_dir()
        .map(Settings::open_user)
        .ok_or_else(|| StoreError::NotOpen.into())
}

fn is_open(state: &ProjectState) -> bool {
    with_store(state, |_| Ok(())).is_ok()
}

pub fn get(state: &ProjectState, key: &str) -> Result<EffectiveSetting, IpcError> {
    let effective = if is_open(state) {
        with_store(state, |store| store.settings_effective(key))?
    } else {
        user_only(state)?.effective(key)?
    };
    Ok(EffectiveSetting {
        value_json: json_text(&effective.value),
        source: effective.source,
    })
}

pub fn set(
    state: &ProjectState,
    layer: Layer,
    key: &str,
    value_json: &str,
) -> Result<(), IpcError> {
    let value = parse(value_json)?;
    if is_open(state) {
        return with_store(state, |store| store.settings_set(layer, key, value));
    }
    if layer == Layer::Project {
        return Err(StoreError::NotOpen.into());
    }
    Ok(user_only(state)?.set(layer, key, value)?)
}

pub fn unset(state: &ProjectState, layer: Layer, key: &str) -> Result<(), IpcError> {
    if is_open(state) {
        return with_store(state, |store| store.settings_unset(layer, key));
    }
    if layer == Layer::Project {
        return Err(StoreError::NotOpen.into());
    }
    Ok(user_only(state)?.unset(layer, key)?)
}

pub fn keys() -> Vec<CoreKey> {
    CORE_KEYS.to_vec()
}

/// 段の生の内容（設定画面用）。
pub fn layer_json(state: &ProjectState, layer: Layer) -> Result<String, IpcError> {
    let map = if is_open(state) {
        with_store(state, |store| Ok(store.settings_layer(layer)))?
    } else {
        if layer == Layer::Project {
            return Err(StoreError::NotOpen.into());
        }
        user_only(state)?.layer(layer).cloned().unwrap_or_default()
    };
    Ok(json_text(&serde_json::Value::Object(map)))
}

pub fn warnings(state: &ProjectState) -> Result<Vec<SettingsIssue>, IpcError> {
    if is_open(state) {
        Ok(with_store(state, |store| Ok(store.settings_warnings()))?)
    } else {
        Ok(user_only(state)?.warnings())
    }
}

/// ファイルが外から変わっていないか確かめて反映する。変わったキーを返す。
pub fn reload(state: &ProjectState) -> Result<Vec<String>, IpcError> {
    with_store(state, |store| store.settings_reload())
}

/// 設定の変更の通知。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SettingsChangedEvent(pub SettingsChanged);

#[tauri::command(async)]
#[specta::specta]
pub fn settings_get(
    state: tauri::State<'_, ProjectState>,
    key: String,
) -> Result<EffectiveSetting, IpcError> {
    get(&state, &key)
}

#[tauri::command(async)]
#[specta::specta]
pub fn settings_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    layer: Layer,
    key: String,
    value_json: String,
) -> Result<(), IpcError> {
    let was_open = is_open(&state);
    set(&state, layer, &key, &value_json)?;
    notify_when_not_open(&app, was_open, layer, &key);
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn settings_unset(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    layer: Layer,
    key: String,
) -> Result<(), IpcError> {
    let was_open = is_open(&state);
    unset(&state, layer, &key)?;
    notify_when_not_open(&app, was_open, layer, &key);
    Ok(())
}

/// 開いているときは、ストアの購読者が通知する。開いていないときだけ、ここで通知する。
fn notify_when_not_open(app: &tauri::AppHandle, was_open: bool, layer: Layer, key: &str) {
    if was_open {
        return;
    }
    let changed = SettingsChanged {
        layer,
        keys: vec![key.to_owned()],
    };
    if let Err(error) = SettingsChangedEvent(changed).emit(app) {
        tracing::warn!(%error, "settings-changed を送れなかった");
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn settings_keys() -> Vec<CoreKey> {
    keys()
}

#[tauri::command(async)]
#[specta::specta]
pub fn settings_layer(
    state: tauri::State<'_, ProjectState>,
    layer: Layer,
) -> Result<String, IpcError> {
    layer_json(&state, layer)
}

#[tauri::command(async)]
#[specta::specta]
pub fn settings_warnings(
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<SettingsIssue>, IpcError> {
    warnings(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn settings_reload(state: tauri::State<'_, ProjectState>) -> Result<Vec<String>, IpcError> {
    reload(&state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_commands::{Hooks, open_project};

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "unnotator-settings-ipc-{}-{}-{n}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(path.join("project")).expect("一時フォルダを作れる");
            Self(path)
        }
        fn project(&self) -> std::path::PathBuf {
            self.0.join("project")
        }
        fn state(&self) -> ProjectState {
            ProjectState::new(self.0.join("recovery")).with_user_settings_dir(self.0.join("user"))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_core_key_table_is_exposed_with_defaults() {
        let table = keys();
        assert_eq!(table.len(), 4);
        assert!(
            table
                .iter()
                .any(|k| k.name == "assets.watch" && k.default_json == "true")
        );
    }

    #[test]
    fn user_settings_work_while_nothing_is_open_but_the_project_layer_does_not() {
        let temp = Temp::new();
        let state = temp.state();
        set(&state, Layer::User, "assets.watch", "false").expect("書ける");
        let got = get(&state, "assets.watch").expect("読める");
        assert_eq!(
            (got.value_json.as_str(), got.source),
            ("false", Source::User)
        );
        assert_eq!(
            layer_json(&state, Layer::User).expect("段"),
            r#"{"assets.watch":false}"#
        );
        assert_eq!(
            set(&state, Layer::Project, "assets.watch", "true")
                .unwrap_err()
                .code,
            "not_open"
        );
        assert_eq!(
            layer_json(&state, Layer::Project).unwrap_err().code,
            "not_open"
        );
        assert_eq!(reload(&state).unwrap_err().code, "not_open");
        unset(&state, Layer::User, "assets.watch").expect("消せる");
        assert_eq!(
            get(&state, "assets.watch").expect("読める").source,
            Source::Default
        );
    }

    #[test]
    fn the_two_layers_are_merged_through_an_open_project() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        set(&state, Layer::User, "assets.watch", "false").expect("書ける");
        set(&state, Layer::Project, "assets.watch", "true").expect("書ける");
        let got = get(&state, "assets.watch").expect("読める");
        assert_eq!(
            (got.value_json.as_str(), got.source),
            ("true", Source::Project)
        );
        assert!(temp.project().join(".unnotator/settings.json").is_file());
        unset(&state, Layer::Project, "assets.watch").expect("消せる");
        assert_eq!(
            get(&state, "assets.watch").expect("読める").source,
            Source::User
        );
    }

    #[test]
    fn bad_input_becomes_a_code() {
        let temp = Temp::new();
        let state = temp.state();
        assert_eq!(
            set(&state, Layer::User, "assets.watch", "not json")
                .unwrap_err()
                .code,
            "invalid_command"
        );
        assert_eq!(
            set(&state, Layer::User, "assets.watch", "\"yes\"")
                .unwrap_err()
                .code,
            "invalid_setting"
        );
    }

    #[test]
    fn external_changes_are_reloaded_and_reported_through_the_hook() {
        use std::sync::{Arc, Mutex};
        let temp = Temp::new();
        let state = temp.state();
        let seen: Arc<Mutex<Vec<SettingsChanged>>> = Arc::default();
        let sink = Arc::clone(&seen);
        let hooks = Hooks {
            settings: Some(Box::new(move |c| {
                sink.lock().expect("lock").push(c.clone())
            })),
            ..Hooks::default()
        };
        open_project(&state, &temp.project(), true, hooks).expect("作れる");
        set(&state, Layer::Project, "assets.watch", "false").expect("書ける");
        assert_eq!(seen.lock().expect("lock").len(), 1);
        assert!(
            reload(&state).expect("読み直せる").is_empty(),
            "自分の書き込みは数えない"
        );
        std::fs::write(
            temp.project().join(".unnotator/settings.json"),
            r#"{"assets.watch": true}"#,
        )
        .expect("書ける");
        assert_eq!(reload(&state).expect("読み直せる"), ["assets.watch"]);
        assert_eq!(seen.lock().expect("lock").len(), 2);
    }
}
