//! プロジェクトの IPC コマンド（contracts/ipc.md）。状態の保持と型の変換だけを行う薄い層。
//! 中身の処理は `unnotator-core`（Tauri に依存しない）にある。

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use unnotator_core::command::Command;
use unnotator_core::error::StoreError;
use unnotator_core::event::ChangeSet;
use unnotator_core::history::UndoState;
use unnotator_core::project::ProjectStore;

/// 開いているプロジェクト（1 つだけ）。コマンドは `Mutex` で直列に処理される。
#[derive(Default)]
pub struct ProjectState(Mutex<Option<ProjectStore>>);

/// IPC のエラー。`code` は安定した識別子で、文言は画面側が i18n で決める。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl From<StoreError> for IpcError {
    fn from(error: StoreError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectInfo {
    pub project_id: String,
    pub folder: String,
    pub schema_version: u32,
    /// 移行したときだけ、移行前の版。
    pub migrated_from: Option<u32>,
}

/// 変更の差分。`apply_command`・`undo`・`redo` がコミットされたあとに通知する。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ProjectChanged(pub ChangeSet);

type Subscriber = Box<dyn Fn(&ChangeSet) + Send>;

fn lock(state: &ProjectState) -> Result<std::sync::MutexGuard<'_, Option<ProjectStore>>, IpcError> {
    state.0.lock().map_err(|_| IpcError {
        code: "internal".to_owned(),
        message: "プロジェクトの状態が壊れている（別の処理が異常終了した）".to_owned(),
    })
}

pub fn open_project(
    state: &ProjectState,
    folder: &Path,
    create: bool,
    subscriber: Option<Subscriber>,
) -> Result<ProjectInfo, IpcError> {
    let mut guard = lock(state)?;
    if guard.is_some() {
        return Err(StoreError::AlreadyOpen.into());
    }
    let mut store = if create {
        ProjectStore::create(folder)?
    } else {
        ProjectStore::open(folder)?
    };
    if let Some(subscriber) = subscriber {
        store.subscribe(subscriber);
    }
    let info = ProjectInfo {
        project_id: store.project_id().to_owned(),
        folder: folder.to_string_lossy().into_owned(),
        schema_version: store.schema_version(),
        migrated_from: None,
    };
    *guard = Some(store);
    Ok(info)
}

pub fn close_project(state: &ProjectState) -> Result<(), IpcError> {
    let store = lock(state)?.take().ok_or(StoreError::NotOpen)?;
    store.close()?;
    Ok(())
}

pub fn apply(state: &ProjectState, command: Command) -> Result<ChangeSet, IpcError> {
    let mut guard = lock(state)?;
    let store = guard.as_mut().ok_or(StoreError::NotOpen)?;
    Ok(store.apply_command(command)?)
}

pub fn undo_state(state: &ProjectState) -> Result<UndoState, IpcError> {
    let guard = lock(state)?;
    Ok(guard.as_ref().ok_or(StoreError::NotOpen)?.undo_state())
}

#[tauri::command(async)]
#[specta::specta]
pub fn project_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    folder: String,
    create: bool,
) -> Result<ProjectInfo, IpcError> {
    let subscriber: Subscriber = Box::new(move |set| {
        if let Err(error) = ProjectChanged(set.clone()).emit(&app) {
            tracing::warn!(%error, "project-changed を送れなかった");
        }
    });
    open_project(&state, Path::new(&folder), create, Some(subscriber))
}

#[tauri::command(async)]
#[specta::specta]
pub fn project_close(state: tauri::State<'_, ProjectState>) -> Result<(), IpcError> {
    close_project(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn apply_command(
    state: tauri::State<'_, ProjectState>,
    command: Command,
) -> Result<ChangeSet, IpcError> {
    apply(&state, command)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use unnotator_core::command::Command;

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "unnotator-ipc-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(&path).expect("一時フォルダを作れる");
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn label() -> Command {
        Command::CreateLabel {
            id: None,
            name: "person".into(),
            name_i18n_json: None,
            color: "#112233".into(),
            hotkey: None,
            sort_order: None,
            hidden: None,
            applies_to_json: None,
        }
    }

    #[test]
    fn open_apply_close_round_trip_with_notification() {
        let temp = Temp::new();
        let state = ProjectState::default();
        let seen: Arc<Mutex<Vec<ChangeSet>>> = Arc::default();
        let sink = Arc::clone(&seen);
        let subscriber: Subscriber = Box::new(move |set| {
            sink.lock().expect("lock").push(set.clone());
        });

        let info = open_project(&state, &temp.0, true, Some(subscriber)).expect("作れる");
        assert_eq!(info.schema_version, 1);
        assert_eq!(info.migrated_from, None);

        let set = apply(&state, label()).expect("適用できる");
        assert_eq!(set.changes.len(), 1);
        assert_eq!(seen.lock().expect("lock").len(), 1);
        assert!(undo_state(&state).expect("状態").can_undo);

        close_project(&state).expect("閉じられる");
        // 閉じたあと
        assert_eq!(apply(&state, label()).unwrap_err().code, "not_open");
        assert_eq!(close_project(&state).unwrap_err().code, "not_open");
        // 開き直すと、保存した内容が残っている（同じプロジェクト）
        let reopened = open_project(&state, &temp.0, false, None).expect("開ける");
        assert_eq!(reopened.project_id, info.project_id);
        close_project(&state).expect("閉じられる");
    }

    #[test]
    fn opening_twice_reports_already_open() {
        let temp = Temp::new();
        let state = ProjectState::default();
        open_project(&state, &temp.0, true, None).expect("作れる");
        let err = open_project(&state, &temp.0, false, None).unwrap_err();
        assert_eq!(err.code, "already_open");
        close_project(&state).expect("閉じられる");
    }

    #[test]
    fn store_errors_become_codes() {
        let state = ProjectState::default();
        let err = open_project(&state, Path::new("/definitely/not/here"), false, None).unwrap_err();
        assert_eq!(err.code, "not_found");
        assert!(!err.message.is_empty());
    }
}
