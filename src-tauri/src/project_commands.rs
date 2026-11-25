//! プロジェクトの IPC コマンド（contracts/ipc.md）。状態の保持と型の変換だけを行う薄い層。
//! 中身の処理は `unnotator-core`（Tauri に依存しない）にある。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use unnotator_core::command::Command;
use unnotator_core::command::label::LabelUsage;
use unnotator_core::error::StoreError;
use unnotator_core::event::ChangeSet;
use unnotator_core::history::UndoState;
use unnotator_core::project::save::{SaveJob, SaveOutcome};
use unnotator_core::project::{
    CloseAction, OpenOutcome, PendingRecovery, ProjectStore, SaveState, StoreConfig,
};
use unnotator_core::recovery::candidate::RecoveryCandidate;
use unnotator_core::recovery::orphan::{self, RecoveryEntry};

/// プロジェクトの状態。復元の候補を選ぶまでの間も、ロックを保持する。
#[derive(Default)]
enum Slot {
    #[default]
    Empty,
    /// 前回の作業用データが残っていて、復元するか破棄するかを待っている。
    Pending(Box<PendingRecovery>, Hooks),
    Open(Box<ProjectStore>),
}

/// 変更の差分の購読者。
pub type ChangeHook = Box<dyn Fn(&ChangeSet) + Send>;
/// 未保存の状態の購読者。
pub type StateHook = Box<dyn Fn(&SaveState) + Send>;

/// 開いたプロジェクトに付ける購読者（画面へのイベント）。
#[derive(Default)]
pub struct Hooks {
    pub changed: Option<ChangeHook>,
    pub state: Option<StateHook>,
}

/// 開いているプロジェクト（1 つだけ）。コマンドは `Mutex` で直列に処理される。
pub struct ProjectState {
    slot: Mutex<Slot>,
    /// 作業用データの置き場（`<app_data_dir>/recovery`）。
    recovery_root: PathBuf,
}

impl ProjectState {
    pub fn new(recovery_root: PathBuf) -> Self {
        Self {
            slot: Mutex::new(Slot::Empty),
            recovery_root,
        }
    }

    pub fn recovery_root(&self) -> &Path {
        &self.recovery_root
    }

    fn config(&self) -> StoreConfig {
        StoreConfig::new(self.recovery_root.clone())
    }
}

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

/// 読めない作業用データを退避したことの知らせ。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecoveryUnusableInfo {
    pub moved_to: String,
    pub reason: String,
}

/// `project_open` の結果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OpenResult {
    Opened {
        info: ProjectInfo,
        recovery_unusable: Option<RecoveryUnusableInfo>,
    },
    /// 前回の作業用データが残っている。`recovery_restore` か `recovery_discard` で選ぶ。
    RecoveryAvailable { candidate: RecoveryCandidate },
}

/// 閉じるときの、未保存の変更の扱い。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CloseChoice {
    Save,
    Discard,
}

impl From<CloseChoice> for CloseAction {
    fn from(choice: CloseChoice) -> Self {
        match choice {
            CloseChoice::Save => Self::Save,
            CloseChoice::Discard => Self::Discard,
        }
    }
}

/// 変更の差分。`apply_command`・`undo`・`redo` がコミットされたあとに通知する。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ProjectChanged(pub ChangeSet);

/// 未保存の状態。適用・Undo・Redo・保存の開始と終了のあとに通知する。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ProjectStateChanged(pub SaveState);

fn lock(state: &ProjectState) -> Result<MutexGuard<'_, Slot>, IpcError> {
    state.slot.lock().map_err(|_| IpcError {
        code: "internal".to_owned(),
        message: "プロジェクトの状態が壊れている（別の処理が異常終了した）".to_owned(),
    })
}

fn info_of(store: &ProjectStore) -> ProjectInfo {
    ProjectInfo {
        project_id: store.project_id().to_owned(),
        folder: store.folder().to_string_lossy().into_owned(),
        schema_version: store.schema_version(),
        migrated_from: store.migrated_from(),
    }
}

fn attach(store: &mut ProjectStore, hooks: Hooks) {
    if let Some(changed) = hooks.changed {
        store.subscribe(changed);
    }
    if let Some(state) = hooks.state {
        store.subscribe_state(state);
    }
}

/// プロジェクトを作る・開く。復元の候補があれば、`RecoveryAvailable` を返して、選ぶのを待つ。
pub fn open_project(
    state: &ProjectState,
    folder: &Path,
    create: bool,
    hooks: Hooks,
) -> Result<OpenResult, IpcError> {
    let mut guard = lock(state)?;
    match &*guard {
        Slot::Open(_) => return Err(StoreError::AlreadyOpen.into()),
        // 復元待ちのまま別のプロジェクトを開くと、待っていた候補は選ばれずに手放される（作業用データは残る）
        Slot::Pending(..) => *guard = Slot::Empty,
        Slot::Empty => {}
    }
    if create {
        let mut store = ProjectStore::create(folder, state.config())?;
        let info = info_of(&store);
        attach(&mut store, hooks);
        *guard = Slot::Open(Box::new(store));
        return Ok(OpenResult::Opened {
            info,
            recovery_unusable: None,
        });
    }
    match ProjectStore::open(folder, state.config())? {
        OpenOutcome::Opened {
            mut store,
            recovery_unusable,
        } => {
            let info = info_of(&store);
            attach(&mut store, hooks);
            *guard = Slot::Open(Box::new(store));
            Ok(OpenResult::Opened {
                info,
                recovery_unusable: recovery_unusable.map(|unusable| RecoveryUnusableInfo {
                    moved_to: unusable.moved_to.to_string_lossy().into_owned(),
                    reason: unusable.reason,
                }),
            })
        }
        OpenOutcome::RecoveryAvailable(pending) => {
            let candidate = pending.candidate().clone();
            *guard = Slot::Pending(Box::new(pending), hooks);
            Ok(OpenResult::RecoveryAvailable { candidate })
        }
    }
}

fn take_pending(guard: &mut Slot) -> Result<(PendingRecovery, Hooks), IpcError> {
    match std::mem::take(guard) {
        Slot::Pending(pending, hooks) => Ok((*pending, hooks)),
        other => {
            *guard = other;
            Err(StoreError::NotOpen.into())
        }
    }
}

/// 復元して開く（未保存のまま再開する）。
pub fn restore_recovery(state: &ProjectState) -> Result<ProjectInfo, IpcError> {
    let mut guard = lock(state)?;
    let (pending, hooks) = take_pending(&mut guard)?;
    // 失敗したときは、待ちを手放す（作業用データは残るので、もう一度開けば候補が出る）
    let mut store = pending.restore()?;
    let info = info_of(&store);
    attach(&mut store, hooks);
    *guard = Slot::Open(Box::new(store));
    Ok(info)
}

/// 作業用データを破棄して、保存済みのプロジェクトを開く。
pub fn discard_recovery(state: &ProjectState) -> Result<ProjectInfo, IpcError> {
    let mut guard = lock(state)?;
    let (pending, hooks) = take_pending(&mut guard)?;
    let mut store = pending.discard()?;
    let info = info_of(&store);
    attach(&mut store, hooks);
    *guard = Slot::Open(Box::new(store));
    Ok(info)
}

/// 閉じる。未保存があって `action` が無いときは、`unsaved_changes` で失敗し、開いたままにする。
pub fn close_project(state: &ProjectState, action: Option<CloseChoice>) -> Result<(), IpcError> {
    let mut guard = lock(state)?;
    let store = match std::mem::take(&mut *guard) {
        Slot::Open(store) => *store,
        other => {
            *guard = other;
            return Err(StoreError::NotOpen.into());
        }
    };
    if let Err(failed) = store.close(action.map(CloseAction::from)) {
        *guard = Slot::Open(Box::new(failed.store));
        return Err(failed.error.into());
    }
    Ok(())
}

fn with_store<T>(
    state: &ProjectState,
    f: impl FnOnce(&mut ProjectStore) -> Result<T, StoreError>,
) -> Result<T, IpcError> {
    let mut guard = lock(state)?;
    match &mut *guard {
        Slot::Open(store) => Ok(f(store)?),
        _ => Err(StoreError::NotOpen.into()),
    }
}

pub fn apply(state: &ProjectState, command: Command) -> Result<ChangeSet, IpcError> {
    with_store(state, |store| store.apply_command(command))
}

pub fn undo_project(state: &ProjectState) -> Result<Option<ChangeSet>, IpcError> {
    with_store(state, ProjectStore::undo)
}

pub fn redo_project(state: &ProjectState) -> Result<Option<ChangeSet>, IpcError> {
    with_store(state, ProjectStore::redo)
}

pub fn usage_of_label(state: &ProjectState, label_id: &str) -> Result<LabelUsage, IpcError> {
    with_store(state, |store| store.label_usage(label_id))
}

pub fn project_undo_state(state: &ProjectState) -> Result<UndoState, IpcError> {
    with_store(state, |store| Ok(store.undo_state()))
}

pub fn project_save_state(state: &ProjectState) -> Result<SaveState, IpcError> {
    with_store(state, |store| Ok(store.save_state()))
}

/// 保存する。実行の間は、状態の `Mutex` を手放す（編集が待たされない。FR-013）。
pub fn save_project(state: &ProjectState) -> Result<SaveState, IpcError> {
    save_project_with(state, SaveJob::run)
}

/// `save_project` の本体。実行の部分を差し替えられる（保存の実行中に、状態を使えることのテスト用）。
pub fn save_project_with(
    state: &ProjectState,
    run: impl FnOnce(SaveJob) -> Result<SaveOutcome, StoreError>,
) -> Result<SaveState, IpcError> {
    // 準備（速い）
    let job = match with_store(state, ProjectStore::begin_save)? {
        Some(job) => job,
        None => return project_save_state(state),
    };
    // 実行（ロックを持たない）
    let result = run(job);
    // 仕上げ（速い）
    with_store(state, |store| match result {
        Ok(outcome) => store.finish_save(outcome),
        Err(error) => {
            store.abort_save();
            Err(error)
        }
    })
}

/// 孤立した作業用データの一覧。
pub fn list_recovery(state: &ProjectState) -> Vec<RecoveryEntry> {
    orphan::list(&state.recovery_root)
}

/// 孤立した作業用データを 1 件削除する。いま開いているプロジェクトのものは削除できない。
pub fn delete_recovery(state: &ProjectState, id: &str) -> Result<(), IpcError> {
    let open_folder = {
        let guard = lock(state)?;
        match &*guard {
            Slot::Open(store) => Some(store.folder().to_path_buf()),
            Slot::Pending(pending, _) => Some(PathBuf::from(&pending.candidate().project_root)),
            Slot::Empty => None,
        }
    };
    orphan::delete(&state.recovery_root, id, open_folder.as_deref())?;
    Ok(())
}

/// アプリの起動時に、30 日を超えた孤立の作業用データを削除する。
pub fn cleanup_recovery(recovery_root: &Path) {
    let now = unnotator_core::clock::Clock::now_ms(&unnotator_core::clock::SystemClock);
    match orphan::cleanup(recovery_root, now, None) {
        Ok(removed) if !removed.is_empty() => {
            tracing::info!(count = removed.len(), "孤立した作業用データを削除した");
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(%error, "孤立した作業用データの掃除に失敗した"),
    }
}

fn hooks_for(app: &tauri::AppHandle) -> Hooks {
    let changed_app = app.clone();
    let state_app = app.clone();
    Hooks {
        changed: Some(Box::new(move |set| {
            if let Err(error) = ProjectChanged(set.clone()).emit(&changed_app) {
                tracing::warn!(%error, "project-changed を送れなかった");
            }
        })),
        state: Some(Box::new(move |save_state| {
            if let Err(error) = ProjectStateChanged(*save_state).emit(&state_app) {
                tracing::warn!(%error, "project-state-changed を送れなかった");
            }
        })),
    }
}

#[tauri::command(async)]
#[specta::specta]
pub fn project_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    folder: String,
    create: bool,
) -> Result<OpenResult, IpcError> {
    open_project(&state, Path::new(&folder), create, hooks_for(&app))
}

#[tauri::command(async)]
#[specta::specta]
pub fn recovery_restore(state: tauri::State<'_, ProjectState>) -> Result<ProjectInfo, IpcError> {
    restore_recovery(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn recovery_discard(state: tauri::State<'_, ProjectState>) -> Result<ProjectInfo, IpcError> {
    discard_recovery(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn project_close(
    state: tauri::State<'_, ProjectState>,
    action: Option<CloseChoice>,
) -> Result<(), IpcError> {
    close_project(&state, action)
}

#[tauri::command(async)]
#[specta::specta]
pub fn project_save(state: tauri::State<'_, ProjectState>) -> Result<SaveState, IpcError> {
    save_project(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn save_state(state: tauri::State<'_, ProjectState>) -> Result<SaveState, IpcError> {
    project_save_state(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn apply_command(
    state: tauri::State<'_, ProjectState>,
    command: Command,
) -> Result<ChangeSet, IpcError> {
    apply(&state, command)
}

#[tauri::command(async)]
#[specta::specta]
pub fn undo(state: tauri::State<'_, ProjectState>) -> Result<Option<ChangeSet>, IpcError> {
    undo_project(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn redo(state: tauri::State<'_, ProjectState>) -> Result<Option<ChangeSet>, IpcError> {
    redo_project(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn undo_state(state: tauri::State<'_, ProjectState>) -> Result<UndoState, IpcError> {
    project_undo_state(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn label_usage(
    state: tauri::State<'_, ProjectState>,
    label_id: String,
) -> Result<LabelUsage, IpcError> {
    usage_of_label(&state, &label_id)
}

#[tauri::command(async)]
#[specta::specta]
pub fn recovery_list(state: tauri::State<'_, ProjectState>) -> Vec<RecoveryEntry> {
    list_recovery(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn recovery_delete(state: tauri::State<'_, ProjectState>, id: String) -> Result<(), IpcError> {
    delete_recovery(&state, &id)
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
            std::fs::create_dir_all(path.join("project")).expect("一時フォルダを作れる");
            Self(path)
        }
        fn project(&self) -> std::path::PathBuf {
            self.0.join("project")
        }
        fn state(&self) -> ProjectState {
            ProjectState::new(self.0.join("recovery"))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// ラベルの名前は一意なので、呼ぶたびに別の名前にする。
    fn label() -> Command {
        static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Command::CreateLabel {
            id: None,
            name: format!("person-{n}"),
            name_i18n_json: None,
            color: "#112233".into(),
            hotkey: None,
            sort_order: None,
            hidden: None,
            applies_to_json: None,
        }
    }

    fn opened(result: OpenResult) -> ProjectInfo {
        match result {
            OpenResult::Opened { info, .. } => info,
            OpenResult::RecoveryAvailable { .. } => panic!("復元の候補が出てはいけない"),
        }
    }

    #[test]
    fn open_apply_close_round_trip_with_notification() {
        let temp = Temp::new();
        let state = temp.state();
        let seen: Arc<Mutex<Vec<ChangeSet>>> = Arc::default();
        let states: Arc<Mutex<Vec<SaveState>>> = Arc::default();
        let (sink, state_sink) = (Arc::clone(&seen), Arc::clone(&states));
        let hooks = Hooks {
            changed: Some(Box::new(move |set| {
                sink.lock().expect("lock").push(set.clone());
            })),
            state: Some(Box::new(move |s| state_sink.lock().expect("lock").push(*s))),
        };

        let info = opened(open_project(&state, &temp.project(), true, hooks).expect("作れる"));
        assert_eq!(info.schema_version, 1);
        assert_eq!(info.migrated_from, None);

        let set = apply(&state, label()).expect("適用できる");
        assert_eq!(set.changes.len(), 1);
        let usage = usage_of_label(&state, &set.changes[0].id).expect("件数");
        assert_eq!(usage.annotations, 0);
        assert_eq!(
            usage_of_label(&state, "missing").unwrap_err().code,
            "not_found"
        );
        assert_eq!(seen.lock().expect("lock").len(), 1);
        assert!(project_undo_state(&state).expect("状態").can_undo);

        // Undo / Redo も通知される
        let undone = undo_project(&state)
            .expect("戻せる")
            .expect("戻す操作がある");
        assert_eq!(undone.origin, unnotator_core::event::Origin::Undo);
        assert!(!project_undo_state(&state).expect("状態").can_undo);
        let redone = redo_project(&state)
            .expect("やり直せる")
            .expect("やり直す操作がある");
        assert_eq!(redone.origin, unnotator_core::event::Origin::Redo);
        assert_eq!(seen.lock().expect("lock").len(), 3);
        assert!(redo_project(&state).expect("状態").is_none());
        // 未保存の状態も、そのたびに通知される
        assert_eq!(states.lock().expect("lock").len(), 3);
        assert!(project_save_state(&state).expect("状態").dirty);

        // 未保存があって、選ばずに閉じようとすると、開いたまま失敗する
        assert_eq!(
            close_project(&state, None).unwrap_err().code,
            "unsaved_changes"
        );
        assert!(project_save_state(&state).expect("開いたまま").dirty);
        close_project(&state, Some(CloseChoice::Save)).expect("保存して閉じられる");
        // 閉じたあと
        assert_eq!(apply(&state, label()).unwrap_err().code, "not_open");
        assert_eq!(undo_project(&state).unwrap_err().code, "not_open");
        assert_eq!(close_project(&state, None).unwrap_err().code, "not_open");
        // 開き直すと、保存した内容が残っている（同じプロジェクト）
        let reopened =
            opened(open_project(&state, &temp.project(), false, Hooks::default()).expect("開ける"));
        assert_eq!(reopened.project_id, info.project_id);
        let again = apply(&state, label()).expect("適用できる");
        assert_eq!(again.changes.len(), 1);
        close_project(&state, Some(CloseChoice::Discard)).expect("閉じられる");
    }

    #[test]
    fn opening_twice_reports_already_open() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        let err = open_project(&state, &temp.project(), false, Hooks::default()).unwrap_err();
        assert_eq!(err.code, "already_open");
        close_project(&state, None).expect("閉じられる");
    }

    #[test]
    fn store_errors_become_codes() {
        let temp = Temp::new();
        let state = temp.state();
        let err = open_project(
            &state,
            Path::new("/definitely/not/here"),
            false,
            Hooks::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, "not_found");
        assert!(!err.message.is_empty());
    }

    #[test]
    fn save_writes_the_project_and_clears_the_state() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        apply(&state, label()).expect("適用できる");
        assert!(project_save_state(&state).expect("状態").dirty);
        let saved = save_project(&state).expect("保存できる");
        assert!(!saved.dirty && !saved.saving);
        assert_eq!(saved.unsaved_count, 0);
        // 未保存が無ければ、何もせず成功
        assert!(!save_project(&state).expect("保存できる").dirty);
        // 保存したので、選ばずに閉じられる
        close_project(&state, None).expect("閉じられる");
    }

    #[test]
    fn the_state_is_usable_while_a_save_is_running() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        apply(&state, label()).expect("適用できる");

        // 実行の最中に、編集・状態の取得・閉じるの拒否ができる（Mutex を手放している）
        let result = save_project_with(&state, |job| {
            assert!(project_save_state(&state).expect("状態").saving);
            apply(&state, label()).expect("保存の間も編集できる");
            assert_eq!(
                close_project(&state, Some(CloseChoice::Save))
                    .unwrap_err()
                    .code,
                "already_saving"
            );
            job.run()
        })
        .expect("保存できる");
        // 保存中の編集は、未保存として残る
        assert!(result.dirty && !result.saving);
        assert_eq!(result.unsaved_count, 1);
        close_project(&state, Some(CloseChoice::Discard)).expect("閉じられる");
    }

    #[test]
    fn a_failed_save_clears_the_saving_flag() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        apply(&state, label()).expect("適用できる");
        let err = save_project_with(&state, |_| Err(StoreError::Io(std::io::Error::other("x"))))
            .unwrap_err();
        assert_eq!(err.code, "io");
        let current = project_save_state(&state).expect("状態");
        assert!(current.dirty && !current.saving);
        close_project(&state, Some(CloseChoice::Discard)).expect("閉じられる");
    }

    #[test]
    fn recovery_can_be_offered_restored_and_discarded_through_the_state() {
        let temp = Temp::new();
        // 編集して、閉じずに手放す（異常終了と同じ）
        {
            let state = temp.state();
            open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
            save_project(&state).expect("保存できる");
            apply(&state, label()).expect("適用できる");
            apply(&state, label()).expect("適用できる");
        }
        // 復元待ちの間は、編集も閉じるもできない
        let state = temp.state();
        let OpenResult::RecoveryAvailable { candidate } =
            open_project(&state, &temp.project(), false, Hooks::default()).expect("開ける")
        else {
            panic!("復元の候補が出るはず");
        };
        assert_eq!(candidate.entry_count, 2);
        assert_eq!(apply(&state, label()).unwrap_err().code, "not_open");
        assert_eq!(close_project(&state, None).unwrap_err().code, "not_open");

        // 復元待ちのまま、もう一度開くと、候補はまた出る（選ぶまで何も消えない）
        let again = open_project(&state, &temp.project(), false, Hooks::default()).expect("開ける");
        assert!(matches!(again, OpenResult::RecoveryAvailable { .. }));

        // 復元すると、未保存のまま再開する
        restore_recovery(&state).expect("復元できる");
        assert_eq!(project_save_state(&state).expect("状態").unsaved_count, 2);
        assert!(project_undo_state(&state).expect("状態").can_undo);
        assert_eq!(restore_recovery(&state).unwrap_err().code, "not_open");
        // 手放す（また異常終了の扱い）
        drop(state);

        // 破棄を選ぶと、保存済みのプロジェクトが開く
        let state = temp.state();
        let result =
            open_project(&state, &temp.project(), false, Hooks::default()).expect("開ける");
        assert!(matches!(result, OpenResult::RecoveryAvailable { .. }));
        discard_recovery(&state).expect("破棄できる");
        assert!(!project_save_state(&state).expect("状態").dirty);
        close_project(&state, None).expect("閉じられる");
        assert!(list_recovery(&state).is_empty());
    }

    #[test]
    fn the_orphan_list_and_delete_are_available_and_refuse_the_open_project() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        apply(&state, label()).expect("適用できる");
        let entries = list_recovery(&state);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].project_exists);
        assert_eq!(
            delete_recovery(&state, &entries[0].id).unwrap_err().code,
            "in_use"
        );
        assert_eq!(delete_recovery(&state, "..").unwrap_err().code, "not_found");
        close_project(&state, Some(CloseChoice::Discard)).expect("閉じられる");
        assert!(list_recovery(&state).is_empty());
    }
}
