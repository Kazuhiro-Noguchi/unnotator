//! プロジェクトフォルダ（`.unnotator/`）の作成・オープン・クローズと、開いている間の状態。

pub mod layout;
pub mod lock;

use std::path::Path;

use rusqlite::{Connection, ErrorCode};

use crate::clock::{Clock, SystemClock};
use crate::command::Command;
use crate::command::apply::{Ctx, run};
use crate::db::migrate::{PROJECT_MIGRATIONS, apply_all, latest_version};
use crate::db::open_connection;
use crate::error::StoreError;
use crate::event::{ChangeObserver, ChangeSet, EventHub, Origin};
use crate::history::recorder::{Recorder, RowOp};
use crate::history::{UndoEntry, UndoStack, UndoState};
use crate::id::{IdGenerator, UuidV7Generator};
use layout::ProjectLayout;
use lock::ProjectLock;

/// 時刻と ID の生成を差し替えるための設定（テスト用）。既定は実際の時刻と UUID v7。
pub struct StoreConfig {
    pub clock: Box<dyn Clock>,
    pub ids: Box<dyn IdGenerator>,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            clock: Box::new(SystemClock),
            ids: Box::new(UuidV7Generator::default()),
        }
    }
}

/// 開いているプロジェクト。開いている間は `.unnotator/lock` を保持する。
pub struct ProjectStore {
    // フィールドの順が Drop の順。接続を閉じてからロックを解放する。
    conn: Connection,
    lock: ProjectLock,
    layout: ProjectLayout,
    project_id: String,
    clock: Box<dyn Clock>,
    ids: Box<dyn IdGenerator>,
    undo: UndoStack,
    hub: EventHub,
    /// 適用・Undo・Redo のたびに増える通し番号。
    seq: u32,
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

/// 読めない・壊れているときの SQLite のエラーを `Corrupt` にする。
fn classify(error: rusqlite::Error) -> StoreError {
    if let rusqlite::Error::SqliteFailure(failure, message) = &error
        && matches!(
            failure.code,
            ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt
        )
    {
        return StoreError::Corrupt(message.clone().unwrap_or_else(|| failure.to_string()));
    }
    StoreError::Sqlite(error)
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

impl ProjectStore {
    /// 新しいプロジェクトを作って開く。
    pub fn create(folder: &Path) -> Result<Self, StoreError> {
        Self::create_with(folder, StoreConfig::default())
    }

    pub fn create_with(folder: &Path, config: StoreConfig) -> Result<Self, StoreError> {
        let StoreConfig { clock, mut ids } = config;
        check_folder(folder)?;
        let layout = ProjectLayout::new(folder);
        std::fs::create_dir_all(&layout.dir)?;
        let lock = ProjectLock::acquire(&layout.lock)?;
        if layout.db.exists() {
            return Err(StoreError::AlreadyExists);
        }

        let conn = open_connection(&layout.db)?;
        match Self::initialize(&conn, clock.as_ref(), ids.as_mut()) {
            Ok(project_id) => Ok(Self::assemble(conn, lock, layout, project_id, clock, ids)),
            Err(error) => {
                // 作りかけのファイルを残さない。
                drop(conn);
                let _ = std::fs::remove_file(&layout.db);
                Err(error)
            }
        }
    }

    /// 空の DB に契約の構造を作り、`meta` を書く。
    fn initialize(
        conn: &Connection,
        clock: &dyn Clock,
        ids: &mut dyn IdGenerator,
    ) -> Result<String, StoreError> {
        let now = clock.now_ms();
        let project_id = ids.next_id(conn, now)?;
        apply_all(conn, PROJECT_MIGRATIONS)?;
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

    fn assemble(
        conn: Connection,
        lock: ProjectLock,
        layout: ProjectLayout,
        project_id: String,
        clock: Box<dyn Clock>,
        ids: Box<dyn IdGenerator>,
    ) -> Self {
        Self {
            conn,
            lock,
            layout,
            project_id,
            clock,
            ids,
            undo: UndoStack::default(),
            hub: EventHub::default(),
            seq: 0,
        }
    }

    /// 既存のプロジェクトを開く。
    pub fn open(folder: &Path) -> Result<Self, StoreError> {
        Self::open_with(folder, StoreConfig::default())
    }

    pub fn open_with(folder: &Path, config: StoreConfig) -> Result<Self, StoreError> {
        check_folder(folder)?;
        let layout = ProjectLayout::new(folder);
        if !layout.db.is_file() {
            return Err(StoreError::NotFound(format!(
                "プロジェクトがありません: {}",
                layout.db.display()
            )));
        }
        let lock = ProjectLock::acquire(&layout.lock)?;
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

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(classify)?;
        let latest = i64::from(latest_version(PROJECT_MIGRATIONS));
        if version > latest {
            return Err(StoreError::TooNew {
                found: version,
                supported: latest,
            });
        }
        if version < latest {
            // 古い版の移行は US5（db/migrate.rs）で実装する。版 1 が最古なので、いまは起こらない。
            return Err(StoreError::MigrationFailed(format!(
                "版 {version} からの移行は未実装"
            )));
        }

        Ok(Self::assemble(
            conn,
            lock,
            layout,
            project_id,
            config.clock,
            config.ids,
        ))
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// このアプリが扱う、プロジェクトデータベースの最新の版。
    pub fn schema_version(&self) -> u32 {
        latest_version(PROJECT_MIGRATIONS)
    }

    pub fn folder(&self) -> &Path {
        &self.layout.folder
    }

    /// 変更の差分の購読者を足す。コミットのあとに、適用ごとに 1 回呼ばれる。
    pub fn subscribe(&mut self, subscriber: Box<dyn Fn(&ChangeSet) + Send>) {
        self.hub.subscribe(subscriber);
    }

    /// コミットの直前に行の変更を受け取る差し込み口を足す（003 の journal 用）。
    pub fn add_observer(&mut self, observer: Box<dyn ChangeObserver>) {
        self.hub.add_observer(observer);
    }

    pub fn undo_state(&self) -> UndoState {
        self.undo.state()
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
        self.hub.run_before_commit(&tx, &ops)?;
        tx.commit()?;
        Ok(self.finish(Origin::Apply, ops))
    }

    /// コミット後の仕上げ: 通し番号・履歴・差分・通知。
    fn finish(&mut self, origin: Origin, ops: Vec<RowOp>) -> ChangeSet {
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
        self.hub.notify(&set);
        set
    }

    /// 閉じて、ロックを解放する。
    pub fn close(self) -> Result<(), StoreError> {
        let Self { conn, lock, .. } = self;
        conn.close()
            .map_err(|(_, error)| StoreError::Sqlite(error))?;
        lock.release()
    }
}
