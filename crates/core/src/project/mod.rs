//! プロジェクトフォルダ（`.unnotator/`）の作成・オープン・クローズと、開いている間の状態。
//!
//! 編集は作業用の複製（`working.db`、WAL）に書き、確定した操作を `journal.db` へ追記する。
//! `project.db` を書くのは、保存の名前の置き換えだけ（research.md R4・R7）。

pub mod layout;
pub mod lock;
pub mod save;
pub mod state;

use std::path::{Path, PathBuf};

use rusqlite::Connection;

use crate::clock::{Clock, SystemClock};
use crate::command::Command;
use crate::command::apply::{Ctx, run};
use crate::command::label::{self, LabelUsage};
use crate::db::migrate::{Migration, PROJECT_MIGRATIONS, apply_all, latest_version, migrate};
use crate::db::{classify, open_connection, open_wal_connection};
use crate::error::StoreError;
use crate::event::{ChangeObserver, ChangeSet, EventHub, Origin};
use crate::history::recorder::{Recorder, RowOp, apply_redo, apply_undo};
use crate::history::{UNDO_LIMIT, UndoEntry, UndoStack, UndoState};
use crate::id::{IdGenerator, UuidV7Generator};
use crate::recovery::candidate::{Inspection, RecoveryCandidate, file_stamp, inspect};
use crate::recovery::journal::{
    Journal, NewEntry, SessionInfo, inverted, ops_from_json, ops_to_json,
};
use crate::recovery::{corrupt_dir_for, journal_path, recovery_dir_for, working_path};
use layout::ProjectLayout;
use lock::ProjectLock;
use save::{SaveJob, SaveOutcome};

pub use crate::recovery::candidate::RecoveryUnusable;
pub use state::SaveState;

/// 時刻と ID の生成を差し替えるための設定（テスト用）。既定は実際の時刻と UUID v7。
pub struct StoreConfig {
    pub clock: Box<dyn Clock>,
    pub ids: Box<dyn IdGenerator>,
    /// 移行の列。既定は契約の `PROJECT_MIGRATIONS`。テストで版を足した列に差し替える。
    pub migrations: &'static [Migration],
    /// 作業用データの置き場（`src-tauri` では `<app_data_dir>/recovery`）。
    pub recovery_root: PathBuf,
}

impl StoreConfig {
    pub fn new(recovery_root: impl Into<PathBuf>) -> Self {
        Self {
            clock: Box::new(SystemClock),
            ids: Box::new(UuidV7Generator::default()),
            migrations: PROJECT_MIGRATIONS,
            recovery_root: recovery_root.into(),
        }
    }
}

/// 閉じるときの、未保存の変更の扱い。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// 保存して閉じる。
    Save,
    /// 保存しないで閉じる（未保存の変更は捨てる）。
    Discard,
}

/// 閉じられなかった。`store` から、そのまま使い続けられる（「閉じるのをやめる」）。
#[derive(Debug)]
pub struct CloseFailed {
    pub store: ProjectStore,
    pub error: StoreError,
}

/// 開いた結果。
// 開くときに 1 回だけ作って、すぐに取り出して使う値なので、箱に入れない。
#[allow(clippy::large_enum_variant)]
#[derive(Debug)]
pub enum OpenOutcome {
    Opened {
        store: ProjectStore,
        /// 読めない作業用データを退避したときだけ。
        recovery_unusable: Option<RecoveryUnusable>,
    },
    /// 前回の作業用データが残っている。`restore` か `discard` を選ぶ。
    RecoveryAvailable(PendingRecovery),
}

type StateSubscriber = Box<dyn Fn(&SaveState) + Send>;

/// 開いているプロジェクト。開いている間は `.unnotator/lock` を保持する。
pub struct ProjectStore {
    // フィールドの順が Drop の順。接続を閉じてからロックを解放する。
    conn: Connection,
    journal: Journal,
    lock: ProjectLock,
    layout: ProjectLayout,
    recovery_dir: PathBuf,
    project_id: String,
    migrations: &'static [Migration],
    migrated_from: Option<u32>,
    clock: Box<dyn Clock>,
    ids: Box<dyn IdGenerator>,
    undo: UndoStack,
    hub: EventHub,
    /// 適用・Undo・Redo のたびに増える通し番号。
    seq: u32,
    unsaved: u32,
    last_change_at: Option<i64>,
    saving: bool,
    state_subscribers: Vec<StateSubscriber>,
}

impl std::fmt::Debug for ProjectStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProjectStore")
            .field("folder", &self.layout.folder)
            .field("project_id", &self.project_id)
            .finish_non_exhaustive()
    }
}

fn check_folder(folder: &Path) -> Result<(), StoreError> {
    if !folder.exists() {
        return Err(StoreError::NotFound(format!(
            "フォルダがありません: {}",
            folder.display()
        )));
    }
    if !folder.is_dir() {
        return Err(StoreError::Io(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            format!("フォルダではありません: {}", folder.display()),
        )));
    }
    Ok(())
}

fn meta_value(conn: &Connection, key: &str) -> Result<Option<String>, StoreError> {
    match conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get::<_, String>(0)
    }) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(classify(error)),
    }
}

fn json_of<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
}

/// 作業用の複製を作って開く（R6）。一時名に書いて、完了してから名前を変える。
fn copy_working_copy(project_db: &Path, dir: &Path) -> Result<Connection, StoreError> {
    std::fs::create_dir_all(dir)?;
    let working = working_path(dir);
    let temporary = dir.join("working.db.tmp");
    std::fs::copy(project_db, &temporary)?;
    std::fs::rename(&temporary, &working)?;
    open_wal_connection(&working)
}

/// 開いた直後のセッションに必要な部品。
struct Parts {
    lock: ProjectLock,
    layout: ProjectLayout,
    dir: PathBuf,
    project_id: String,
    migrations: &'static [Migration],
    migrated_from: Option<u32>,
    clock: Box<dyn Clock>,
    ids: Box<dyn IdGenerator>,
}

impl ProjectStore {
    /// 新しいプロジェクトを作って開く。
    pub fn create(folder: &Path, config: StoreConfig) -> Result<Self, StoreError> {
        let StoreConfig {
            clock,
            mut ids,
            migrations,
            recovery_root,
        } = config;
        check_folder(folder)?;
        let layout = ProjectLayout::new(folder);
        std::fs::create_dir_all(&layout.dir)?;
        let lock = ProjectLock::acquire(&layout.lock)?;
        if layout.db.exists() {
            return Err(StoreError::AlreadyExists);
        }

        let conn = open_connection(&layout.db)?;
        let project_id = match Self::initialize(&conn, clock.as_ref(), ids.as_mut(), migrations) {
            Ok(project_id) => project_id,
            Err(error) => {
                // 作りかけのファイルを残さない。
                drop(conn);
                let _ = std::fs::remove_file(&layout.db);
                return Err(error);
            }
        };
        drop(conn);

        // 同じ場所に、以前のプロジェクトの作業用データが残っていれば、別のものとして退避する。
        let dir = recovery_dir_for(&recovery_root, folder);
        if dir.exists() {
            let _ = std::fs::rename(
                &dir,
                corrupt_dir_for(&recovery_root, folder, clock.now_ms()),
            );
        }
        let result = Self::start_session(Parts {
            lock,
            layout,
            dir: dir.clone(),
            project_id,
            migrations,
            migrated_from: None,
            clock,
            ids,
        });
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        result
    }

    /// 空の DB に契約の構造を作り、`meta` を書く。
    fn initialize(
        conn: &Connection,
        clock: &dyn Clock,
        ids: &mut dyn IdGenerator,
        migrations: &[Migration],
    ) -> Result<String, StoreError> {
        let now = clock.now_ms();
        let project_id = ids.next_id(conn, now)?;
        apply_all(conn, migrations)?;
        let tx = conn.unchecked_transaction()?;
        for (key, value) in [
            (
                "schema_version",
                latest_version(PROJECT_MIGRATIONS).to_string(),
            ),
            ("project_id", project_id.clone()),
            ("created_at", now.to_string()),
            ("app_version", env!("CARGO_PKG_VERSION").to_owned()),
        ] {
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)",
                [key, value.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(project_id)
    }

    /// 既存のプロジェクトを開く。前回の作業用データが残っていれば、復元の候補を返す。
    pub fn open(folder: &Path, config: StoreConfig) -> Result<OpenOutcome, StoreError> {
        check_folder(folder)?;
        let layout = ProjectLayout::new(folder);
        if !layout.db.is_file() {
            return Err(StoreError::NotFound(format!(
                "プロジェクトがありません: {}",
                layout.db.display()
            )));
        }
        // ロックを取れた = 前回のセッションの持ち主はもう存在しない（R2）
        let lock = ProjectLock::acquire(&layout.lock)?;
        let dir = recovery_dir_for(&config.recovery_root, folder);

        let mut recovery_unusable = None;
        match inspect(&dir, &layout.db) {
            Inspection::Missing => {}
            Inspection::Residue => {
                std::fs::remove_dir_all(&dir)?;
            }
            Inspection::Unusable(reason) => {
                let moved_to =
                    corrupt_dir_for(&config.recovery_root, folder, config.clock.now_ms());
                std::fs::rename(&dir, &moved_to)?;
                tracing::warn!(?moved_to, %reason, "読めない作業用データを退避した");
                recovery_unusable = Some(RecoveryUnusable { moved_to, reason });
            }
            Inspection::Candidate(candidate) => {
                return Ok(OpenOutcome::RecoveryAvailable(PendingRecovery {
                    lock,
                    layout,
                    config,
                    dir,
                    candidate,
                }));
            }
        }
        let store = Self::open_saved(lock, layout, dir, config)?;
        Ok(OpenOutcome::Opened {
            store,
            recovery_unusable,
        })
    }

    /// 保存済みのプロジェクトを、新しい作業用の複製で開く（R2 の手順 3〜5）。
    fn open_saved(
        lock: ProjectLock,
        layout: ProjectLayout,
        dir: PathBuf,
        config: StoreConfig,
    ) -> Result<Self, StoreError> {
        let StoreConfig {
            clock,
            ids,
            migrations,
            ..
        } = config;
        let (project_id, migrated_from) = {
            let conn = open_connection(&layout.db)?;
            let has_meta: bool = conn
                .query_row(
                    "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
                    [],
                    |row| row.get(0),
                )
                .map_err(classify)?;
            if !has_meta {
                return Err(StoreError::NotAProject);
            }
            let project_id = meta_value(&conn, "project_id")?.ok_or(StoreError::NotAProject)?;
            // 版を確かめ、古ければ移行する（新しすぎる版は、何も書き換えずに拒否する）。
            let migrated_from = migrate(&conn, &layout.backup, migrations)?;
            (project_id, migrated_from)
        };
        // 保存の途中で落ちたときの一時ファイル（FR-024）
        let _ = std::fs::remove_file(layout.dir.join("project.db.saving"));

        let result = Self::start_session(Parts {
            lock,
            layout,
            dir: dir.clone(),
            project_id,
            migrations,
            migrated_from,
            clock,
            ids,
        });
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        result
    }

    /// 作業用の複製と変更履歴を作り、セッションを始める。
    fn start_session(parts: Parts) -> Result<Self, StoreError> {
        let Parts {
            lock,
            layout,
            dir,
            project_id,
            migrations,
            migrated_from,
            clock,
            ids,
        } = parts;
        let conn = copy_working_copy(&layout.db, &dir)?;
        let (base_mtime_ms, base_size) = file_stamp(&layout.db);
        let session = SessionInfo {
            project_root: layout.folder.to_string_lossy().into_owned(),
            project_id: project_id.clone(),
            base_mtime_ms,
            base_size,
            opened_at: clock.now_ms(),
            last_change_at: None,
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
        };
        let journal = Journal::create(&journal_path(&dir), &session)?;
        Ok(Self {
            conn,
            journal,
            lock,
            layout,
            recovery_dir: dir,
            project_id,
            migrations,
            migrated_from,
            clock,
            ids,
            undo: UndoStack::default(),
            hub: EventHub::default(),
            seq: 0,
            unsaved: 0,
            last_change_at: None,
            saving: false,
            state_subscribers: Vec::new(),
        })
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// このアプリが扱う、プロジェクトデータベースの最新の版。
    pub fn schema_version(&self) -> u32 {
        latest_version(self.migrations)
    }

    /// 開くときに移行した場合、移行前の版。
    pub fn migrated_from(&self) -> Option<u32> {
        self.migrated_from
    }

    pub fn folder(&self) -> &Path {
        &self.layout.folder
    }

    /// 変更の差分の購読者を足す。コミットのあとに、適用ごとに 1 回呼ばれる。
    pub fn subscribe(&mut self, subscriber: Box<dyn Fn(&ChangeSet) + Send>) {
        self.hub.subscribe(subscriber);
    }

    /// コミットの直前に行の変更を受け取る差し込み口を足す。
    pub fn add_observer(&mut self, observer: Box<dyn ChangeObserver>) {
        self.hub.add_observer(observer);
    }

    /// 未保存の状態が変わるたびに呼ばれる購読者を足す。
    pub fn subscribe_state(&mut self, subscriber: Box<dyn Fn(&SaveState) + Send>) {
        self.state_subscribers.push(subscriber);
    }

    /// ラベルを使っているものの件数（削除の前に、付け替えか一緒に削除かを選ばせるため）。
    pub fn label_usage(&self, label_id: &str) -> Result<LabelUsage, StoreError> {
        label::usage(&self.conn, label_id)
    }

    pub fn undo_state(&self) -> UndoState {
        self.undo.state()
    }

    /// 未保存の状態。
    pub fn save_state(&self) -> SaveState {
        SaveState::new(self.unsaved, self.last_change_at, self.saving)
    }

    fn notify_state(&self) {
        let state = self.save_state();
        for subscriber in &self.state_subscribers {
            subscriber(&state);
        }
    }

    /// プロジェクトデータを変更する唯一の入口（憲章 III）。
    /// 全体が適用されるか、まったく適用されないかのどちらか。
    pub fn apply_command(&mut self, command: Command) -> Result<ChangeSet, StoreError> {
        let now = self.clock.now_ms();
        let tx = self.conn.unchecked_transaction()?;
        let ops = {
            let mut ctx = Ctx::new(Recorder::new(&tx), now, self.ids.as_mut());
            run(&mut ctx, &command)?;
            ctx.into_recorder().into_ops()
        };
        self.hub.run_before_commit(&tx, Origin::Apply, &ops)?;
        tx.commit()?;
        let entry = EntryMeta {
            label: command.name().to_owned(),
            source: command.source().unwrap_or("user").to_owned(),
            command_json: json_of(&command),
            inverse: ops.clone(),
        };
        Ok(self.finish(Origin::Apply, ops, &entry))
    }

    /// 直前の操作を元に戻す。戻す操作が無ければ `None`。
    pub fn undo(&mut self) -> Result<Option<ChangeSet>, StoreError> {
        let Some(entry) = self.undo.undo_top() else {
            return Ok(None);
        };
        let ops = entry.ops.clone();
        let tx = self.conn.unchecked_transaction()?;
        apply_undo(&tx, &ops)?;
        self.hub.run_before_commit(&tx, Origin::Undo, &ops)?;
        tx.commit()?;
        self.undo.commit_undo();
        let entry = EntryMeta {
            label: "undo".to_owned(),
            source: "user".to_owned(),
            command_json: "{\"kind\":\"undo\"}".to_owned(),
            inverse: inverted(&ops),
        };
        Ok(Some(self.finish(Origin::Undo, ops, &entry)))
    }

    /// 直前に戻した操作をやり直す。やり直す操作が無ければ `None`。
    pub fn redo(&mut self) -> Result<Option<ChangeSet>, StoreError> {
        let Some(entry) = self.undo.redo_top() else {
            return Ok(None);
        };
        let ops = entry.ops.clone();
        let tx = self.conn.unchecked_transaction()?;
        apply_redo(&tx, &ops)?;
        self.hub.run_before_commit(&tx, Origin::Redo, &ops)?;
        tx.commit()?;
        self.undo.commit_redo();
        let entry = EntryMeta {
            label: "redo".to_owned(),
            source: "user".to_owned(),
            command_json: "{\"kind\":\"redo\"}".to_owned(),
            inverse: ops.clone(),
        };
        Ok(Some(self.finish(Origin::Redo, ops, &entry)))
    }

    /// コミット後の仕上げ: 通し番号・履歴・変更履歴（journal）・差分・通知。
    fn finish(&mut self, origin: Origin, ops: Vec<RowOp>, entry: &EntryMeta) -> ChangeSet {
        self.seq += 1;
        let conn = &self.conn;
        let lookup = |annotation_id: &str| -> Option<String> {
            conn.query_row(
                "SELECT asset_id FROM annotations WHERE id = ?1",
                [annotation_id],
                |row| row.get(0),
            )
            .ok()
        };
        let set = ChangeSet::from_ops(self.seq, origin, &ops, &lookup);
        if ops.is_empty() {
            return set;
        }
        if origin == Origin::Apply {
            self.undo.push(UndoEntry { seq: self.seq, ops });
        }
        self.append_journal(entry, set.asset_ids.first().map(String::as_str));
        self.hub.notify(&set);
        self.notify_state();
        set
    }

    /// 確定した操作を `journal.db` へ追記する。失敗しても、編集は失われない（`working.db` が正。R4）。
    fn append_journal(&mut self, entry: &EntryMeta, asset_id: Option<&str>) {
        let at = self.clock.now_ms();
        self.unsaved = self.unsaved.saturating_add(1);
        self.last_change_at = Some(at);
        let inverse_json = ops_to_json(&entry.inverse);
        let result = self.journal.append(&NewEntry {
            at,
            label: &entry.label,
            source: &entry.source,
            asset_id,
            command_json: &entry.command_json,
            inverse_json: &inverse_json,
        });
        if let Err(error) = result {
            tracing::warn!(%error, "変更履歴（journal）へ追記できなかった。編集は作業用の複製に入っている");
        }
    }

    // ---- 保存 ----

    /// 保存の準備。未保存の変更が無ければ `None`（何もせず成功）。保存中なら `already_saving`。
    pub fn begin_save(&mut self) -> Result<Option<SaveJob>, StoreError> {
        if self.saving {
            return Err(StoreError::AlreadySaving);
        }
        if self.unsaved == 0 {
            return Ok(None);
        }
        let base_seq = self.journal.max_seq().unwrap_or_else(|error| {
            tracing::warn!(%error, "変更履歴の末尾を読めなかった");
            0
        });
        self.saving = true;
        self.notify_state();
        Ok(Some(SaveJob {
            working: working_path(&self.recovery_dir),
            temporary: self.layout.dir.join("project.db.saving"),
            target: self.layout.db.clone(),
            project_id: self.project_id.clone(),
            schema_version: self.schema_version(),
            base_seq,
            saved_count: self.unsaved,
        }))
    }

    /// 保存の仕上げ。保存した分の変更履歴を片付け、保存中の編集は未保存として残す。
    pub fn finish_save(&mut self, outcome: SaveOutcome) -> Result<SaveState, StoreError> {
        if let Err(error) =
            self.journal
                .finish_save(outcome.base_seq, outcome.mtime_ms, outcome.size)
        {
            tracing::warn!(%error, "保存後の変更履歴の片付けに失敗した");
        }
        self.unsaved = self.unsaved.saturating_sub(outcome.saved_count);
        if self.unsaved == 0 {
            self.last_change_at = None;
        }
        self.saving = false;
        self.notify_state();
        Ok(self.save_state())
    }

    /// 保存の実行が失敗・中断したとき、保存中の印を下ろす。編集は未保存のまま残る。
    pub fn abort_save(&mut self) {
        if self.saving {
            self.saving = false;
            self.notify_state();
        }
    }

    /// 準備・実行・仕上げを続けて行う。
    pub fn save(&mut self) -> Result<SaveState, StoreError> {
        let Some(job) = self.begin_save()? else {
            return Ok(self.save_state());
        };
        match job.run() {
            Ok(outcome) => self.finish_save(outcome),
            Err(error) => {
                self.abort_save();
                Err(error)
            }
        }
    }

    // ---- 閉じる ----

    /// 閉じて、ロックを解放する。未保存の変更があるときは、`action` で保存か破棄を指定する。
    /// 指定が無いときは、閉じずに `unsaved_changes` で失敗し、`CloseFailed` から `ProjectStore` を取り戻せる。
    // 失敗したときに、`ProjectStore` を返すのが目的なので、`Err` が大きいのは意図どおり。
    #[allow(clippy::result_large_err)]
    pub fn close(mut self, action: Option<CloseAction>) -> Result<(), CloseFailed> {
        if self.saving {
            return Err(CloseFailed {
                store: self,
                error: StoreError::AlreadySaving,
            });
        }
        if self.unsaved > 0 {
            match action {
                None => {
                    return Err(CloseFailed {
                        store: self,
                        error: StoreError::UnsavedChanges,
                    });
                }
                Some(CloseAction::Save) => {
                    if let Err(error) = self.save() {
                        return Err(CloseFailed { store: self, error });
                    }
                }
                Some(CloseAction::Discard) => {}
            }
        }
        let Self {
            conn,
            journal,
            lock,
            recovery_dir,
            ..
        } = self;
        if let Err((_, error)) = conn.close() {
            tracing::warn!(%error, "作業用の複製を閉じられなかった");
        }
        if let Err(error) = journal.close() {
            tracing::warn!(%error, "変更履歴を閉じられなかった");
        }
        if let Err(error) = std::fs::remove_dir_all(&recovery_dir) {
            tracing::warn!(%error, "作業用データを削除できなかった");
        }
        if let Err(error) = lock.release() {
            tracing::warn!(%error, "ロックを解放できなかった");
        }
        Ok(())
    }
}

/// 変更履歴に書く、1 件分の情報。
struct EntryMeta {
    label: String,
    source: String,
    command_json: String,
    /// `working.db` への順方向の変更。
    inverse: Vec<RowOp>,
}

/// 前回の作業用データが残っているときの、復元の候補。ロックを保持し、選ぶまで何も変えない。
/// 選ばずに `drop` しても、何も変わらない。
pub struct PendingRecovery {
    lock: ProjectLock,
    layout: ProjectLayout,
    config: StoreConfig,
    dir: PathBuf,
    candidate: RecoveryCandidate,
}

impl std::fmt::Debug for PendingRecovery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingRecovery")
            .field("folder", &self.layout.folder)
            .field("candidate", &self.candidate)
            .finish_non_exhaustive()
    }
}

impl PendingRecovery {
    pub fn candidate(&self) -> &RecoveryCandidate {
        &self.candidate
    }

    /// 作業用の複製をそのまま使って、未保存のまま再開する。Undo の履歴は変更履歴から作り直す（最大 500 件）。
    pub fn restore(self) -> Result<ProjectStore, StoreError> {
        let Self {
            lock,
            layout,
            config,
            dir,
            ..
        } = self;
        let StoreConfig {
            clock,
            ids,
            migrations,
            ..
        } = config;
        // 保存の途中で落ちたときの一時ファイル（FR-024）
        let _ = std::fs::remove_file(layout.dir.join("project.db.saving"));
        let conn = open_wal_connection(&working_path(&dir))?;
        let project_id = meta_value(&conn, "project_id")?.ok_or(StoreError::NotAProject)?;
        let migrated_from = migrate(&conn, &dir.join("working.db.bak"), migrations)?;

        let journal = Journal::open(&journal_path(&dir))?;
        journal.restart_session(clock.now_ms(), std::process::id())?;
        let session = journal.session()?;
        let mut undo = UndoStack::default();
        let mut seq = 0;
        // 記録の中身が古い構造を指すので、移行したときは、履歴を空にする（FR-022）
        if migrated_from.is_none() {
            let mut rebuilt: Vec<Vec<RowOp>> = Vec::new();
            for entry in journal.recent(UNDO_LIMIT)? {
                match ops_from_json(&entry.inverse_json) {
                    Ok(ops) => rebuilt.push(ops),
                    Err(unreadable) => {
                        tracing::warn!(seq = entry.seq, reason = %unreadable.0, "読めない記録で Undo の再構築を止める");
                        break;
                    }
                }
            }
            for ops in rebuilt.into_iter().rev() {
                seq += 1;
                undo.push(UndoEntry { seq, ops });
            }
        }
        let unsaved = journal.entry_count()?;
        Ok(ProjectStore {
            conn,
            journal,
            lock,
            layout,
            recovery_dir: dir,
            project_id,
            migrations,
            migrated_from,
            clock,
            ids,
            undo,
            hub: EventHub::default(),
            seq,
            unsaved,
            last_change_at: session.last_change_at,
            saving: false,
            state_subscribers: Vec::new(),
        })
    }

    /// 作業用データを破棄して、保存済みのプロジェクトを通常に開く。
    pub fn discard(self) -> Result<ProjectStore, StoreError> {
        let Self {
            lock,
            layout,
            config,
            dir,
            ..
        } = self;
        std::fs::remove_dir_all(&dir)?;
        ProjectStore::open_saved(lock, layout, dir, config)
    }
}
