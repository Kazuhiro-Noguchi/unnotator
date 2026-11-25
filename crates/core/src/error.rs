//! エラー型。IPC には `code()` の安定した文字列で返し、文言は画面側（i18n）が決める。

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    /// 別のプロセス（または別のウィンドウ）が同じプロジェクトを開いている。
    #[error("プロジェクトは別の場所で使用中です")]
    InUse,
    /// フォルダ・プロジェクト・参照先が見つからない。
    #[error("見つかりません: {0}")]
    NotFound(String),
    /// SQLite ではあるが、プロジェクトのデータベースではない。
    #[error("プロジェクトのデータベースではありません")]
    NotAProject,
    /// 壊れていて読めない。
    #[error("データベースが壊れています: {0}")]
    Corrupt(String),
    /// アプリが知っているより新しい版。
    #[error("新しい版のプロジェクトです（プロジェクト: {found}、このアプリ: {supported}）")]
    TooNew { found: i64, supported: i64 },
    /// 移行に失敗した（元のプロジェクトは変わっていない）。
    #[error("移行に失敗しました: {0}")]
    MigrationFailed(String),
    /// 契約に反する値・入れ子の transaction など。
    #[error("コマンドが不正です: {0}")]
    InvalidCommand(String),
    /// 作成しようとした場所に、すでにプロジェクトがある。
    #[error("すでにプロジェクトがあります")]
    AlreadyExists,
    /// 使用中のラベルを、付け替えも一緒に削除も指定せずに削除しようとした。
    #[error(
        "ラベルが使われています（アノテーション {annotations}・関係 {relations}・グループ {groups}）"
    )]
    LabelInUse {
        annotations: u64,
        relations: u64,
        groups: u64,
    },
    /// すでに別のプロジェクトを開いている（IPC の状態）。
    #[error("すでにプロジェクトを開いています")]
    AlreadyOpen,
    /// プロジェクトを開いていない（IPC の状態）。
    #[error("プロジェクトを開いていません")]
    NotOpen,
    /// 未保存の変更があるのに、保存も破棄も指定せずに閉じようとした。
    #[error("未保存の変更があります")]
    UnsavedChanges,
    /// 保存中に、もう一度保存・閉じるを指示した。
    #[error("保存中です")]
    AlreadySaving,
    /// 走査を同時に 2 つ走らせた。
    #[error("走査中です")]
    ScanInProgress,
    /// 設定の値が、型・範囲・重なりの検証に反する。
    #[error("設定 {key} が正しくありません: {why}")]
    InvalidSetting { key: String, why: String },
    /// 設定ファイルが壊れていて読めない。
    #[error("設定ファイルを読めません（{layer}）: {why}")]
    SettingsUnreadable { layer: String, why: String },
    /// ロックを持っていない（読み取り専用）ので書き込めない。
    #[error("読み取り専用のため書き込めません")]
    ReadOnly,
    /// テスト用の停止点で、保存を途中で打ち切った。
    #[error("保存を途中で打ち切りました（テスト用）")]
    Aborted,
    #[error("ファイル操作に失敗しました: {0}")]
    Io(#[from] std::io::Error),
    #[error("データベースの操作に失敗しました: {0}")]
    Sqlite(#[from] rusqlite::Error),
}

impl StoreError {
    /// 機械が読む、安定した識別子（contracts/ipc.md）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::InUse => "in_use",
            Self::NotFound(_) => "not_found",
            Self::AlreadyExists => "already_exists",
            Self::NotAProject => "not_a_project",
            Self::Corrupt(_) => "corrupt",
            Self::TooNew { .. } => "too_new",
            Self::MigrationFailed(_) => "migration_failed",
            Self::InvalidCommand(_) => "invalid_command",
            Self::LabelInUse { .. } => "label_in_use",
            Self::AlreadyOpen => "already_open",
            Self::NotOpen => "not_open",
            Self::UnsavedChanges => "unsaved_changes",
            Self::AlreadySaving => "already_saving",
            Self::ScanInProgress => "scan_in_progress",
            Self::InvalidSetting { .. } => "invalid_setting",
            Self::SettingsUnreadable { .. } => "settings_unreadable",
            Self::ReadOnly => "read_only",
            Self::Aborted => "aborted",
            Self::Io(_) => "io",
            Self::Sqlite(_) => "internal",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_identifiers() {
        let cases: Vec<(StoreError, &str)> = vec![
            (StoreError::InUse, "in_use"),
            (StoreError::NotFound("x".into()), "not_found"),
            (StoreError::AlreadyExists, "already_exists"),
            (StoreError::NotAProject, "not_a_project"),
            (StoreError::Corrupt("x".into()), "corrupt"),
            (
                StoreError::TooNew {
                    found: 2,
                    supported: 1,
                },
                "too_new",
            ),
            (StoreError::MigrationFailed("x".into()), "migration_failed"),
            (StoreError::InvalidCommand("x".into()), "invalid_command"),
            (
                StoreError::LabelInUse {
                    annotations: 1,
                    relations: 0,
                    groups: 0,
                },
                "label_in_use",
            ),
            (StoreError::AlreadyOpen, "already_open"),
            (StoreError::NotOpen, "not_open"),
            (StoreError::UnsavedChanges, "unsaved_changes"),
            (StoreError::AlreadySaving, "already_saving"),
            (StoreError::ScanInProgress, "scan_in_progress"),
            (
                StoreError::InvalidSetting {
                    key: "k".into(),
                    why: "w".into(),
                },
                "invalid_setting",
            ),
            (
                StoreError::SettingsUnreadable {
                    layer: "user".into(),
                    why: "w".into(),
                },
                "settings_unreadable",
            ),
            (StoreError::ReadOnly, "read_only"),
            (StoreError::Aborted, "aborted"),
            (StoreError::Io(std::io::Error::other("x")), "io"),
            (
                StoreError::Sqlite(rusqlite::Error::InvalidQuery),
                "internal",
            ),
        ];
        for (error, code) in cases {
            assert_eq!(error.code(), code, "{error}");
        }
    }

    #[test]
    fn messages_are_not_empty() {
        assert!(!StoreError::InUse.to_string().is_empty());
    }
}
