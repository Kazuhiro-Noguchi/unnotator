//! 拡張機能まわりのエラー。

use thiserror::Error;
use unnotator_core::error::StoreError;

#[derive(Debug, Error)]
pub enum ExtensionError {
    #[error("入出力エラー: {0}")]
    Io(#[from] std::io::Error),
    #[error("書き込みに失敗しました: {0}")]
    Write(#[from] StoreError),
    /// パッケージの検査に通らなかった（理由は文章）。
    #[error("パッケージを取り込めません: {0}")]
    Package(String),
    #[error("すでに導入済みです: {id} {version}")]
    AlreadyInstalled { id: String, version: String },
    #[error("見つかりません: {0}")]
    NotFound(String),
    #[error("不正な値です: {0}")]
    Invalid(String),
    #[error("開発者モードがオフです")]
    DevModeOff,
    #[error("ファイルを読めません: {0}")]
    Json(#[from] serde_json::Error),
}
