//! unnotator-core

pub mod clock;
pub mod command;
pub mod db;
pub mod error;
pub mod event;
pub mod history;
pub mod id;

/// DB スキーマ（契約の正本の SQL をそのまま埋め込む）。
pub mod migrations {
    /// プロジェクト DB（`project.db`・作業用コピー）の v1。
    pub const PROJECT_V1: &str = include_str!("../migrations/project/0001_init.sql");
    /// 復旧用 DB（変更履歴 journal）の v1。
    pub const RECOVERY_V1: &str = include_str!("../migrations/recovery/0001_init.sql");
}
