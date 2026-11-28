//! 権限の門（research.md R7、`specs/009-extension-host/contracts/host-api-gate.md`）。
//!
//! Host API のメソッド・コアのコマンド → 必要な権限、の表は `host-api-permissions.json` の 1 か所に置く
//! （TS の本体も同じファイルを読む）。同意の保存と判定は `consent.rs`。ここは、表を引いて
//! 「有効か・宣言しているか・同意があるか」を順に確かめる。表にないものは拒否する。

use std::sync::OnceLock;

use serde_json::Value;
use thiserror::Error;

use crate::consent::{ConsentStore, PermissionVerdict};
use crate::registry::{ExtensionEntry, ExtensionStatus};

/// 共有の権限表（JSON の本文）。
pub const TABLE_JSON: &str = include_str!("../host-api-permissions.json");

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum GateError {
    #[error("拡張機能が有効ではありません")]
    Disabled,
    #[error("権限 {permission} を宣言していません")]
    Denied { permission: String },
    #[error("権限 {permission} の同意がありません")]
    NeedsConsent { permission: String, warning: bool },
    #[error("表にない権限です: {0}")]
    UnknownPermission(String),
    #[error("表にないメソッドです: {0}")]
    UnknownMethod(String),
    #[error("拡張機能には開いていません: {0}")]
    NotOpen(String),
}

fn table() -> &'static Value {
    static TABLE: OnceLock<Value> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(TABLE_JSON).unwrap_or_else(|error| {
            // 埋め込みの JSON が壊れていることはテストが防ぐ。壊れていれば、すべて拒否する。
            tracing::error!(%error, "権限表を読めません");
            Value::Null
        })
    })
}

fn is_known_permission(permission: &str) -> bool {
    table()["permissions"]
        .as_array()
        .is_some_and(|list| list.iter().any(|p| p.as_str() == Some(permission)))
}

/// Host API のメソッドに必要な権限。`Ok(None)` は不要。
pub fn required_for_method(method: &str) -> Result<Option<&'static str>, GateError> {
    match table()["methods"].get(method) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(permission)) => Ok(Some(permission.as_str())),
        _ => Err(GateError::UnknownMethod(method.to_owned())),
    }
}

/// コアのコマンド（`Command::name()`）に必要な権限。
pub fn required_for_command(name: &str) -> Result<&'static str, GateError> {
    match table()["commands"].get(name) {
        Some(Value::String(permission)) => Ok(permission.as_str()),
        Some(Value::Bool(false)) => Err(GateError::NotOpen(name.to_owned())),
        _ => Err(GateError::UnknownMethod(name.to_owned())),
    }
}

/// 権限を持っているか。有効でない拡張機能は、何も許されない。
pub fn check_permission(
    consent: &ConsentStore,
    entry: &ExtensionEntry,
    permission: &str,
) -> Result<(), GateError> {
    if !matches!(entry.status, ExtensionStatus::Enabled { .. }) {
        return Err(GateError::Disabled);
    }
    if !is_known_permission(permission) {
        return Err(GateError::UnknownPermission(permission.to_owned()));
    }
    match consent.check(entry, permission) {
        PermissionVerdict::Allowed => Ok(()),
        PermissionVerdict::NeedsConsent { warning } => Err(GateError::NeedsConsent {
            permission: permission.to_owned(),
            warning,
        }),
        PermissionVerdict::Denied => Err(GateError::Denied {
            permission: permission.to_owned(),
        }),
    }
}

/// Host API のメソッドを呼んでよいか。
pub fn check_method(
    consent: &ConsentStore,
    entry: &ExtensionEntry,
    method: &str,
) -> Result<(), GateError> {
    let required = required_for_method(method)?;
    if !matches!(entry.status, ExtensionStatus::Enabled { .. }) {
        return Err(GateError::Disabled);
    }
    match required {
        None => Ok(()),
        Some(permission) => check_permission(consent, entry, permission),
    }
}

/// コアのコマンドを適用してよいか（`Transaction` は、呼び出し側が中身を 1 つずつ確かめる）。
pub fn check_command(
    consent: &ConsentStore,
    entry: &ExtensionEntry,
    command_name: &str,
) -> Result<(), GateError> {
    let permission = required_for_command(command_name)?;
    check_permission(consent, entry, permission)
}
