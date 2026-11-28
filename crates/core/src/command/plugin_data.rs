//! 拡張機能専用の保存領域（`plugin_data`。`host.storage`）。Undo に積まない（`undoable()` が false）が、
//! 未保存に数えて保存の対象にする（`ProjectStore::apply_command` が扱う）。
//!
//! 行は `Recorder` を通さない（`db::tables` に載せない表。Undo の対象外）。

use rusqlite::params;

use super::apply::Ctx;
use super::rows::mismatch;
use super::validate::json_text;
use super::{Command, PluginScope};
use crate::error::StoreError;

/// 1 つの値（JSON の文字列）の大きさの上限（バイト）。
pub const MAX_PLUGIN_VALUE_BYTES: usize = 1024 * 1024;
/// キーの長さの上限（バイト）。
pub const MAX_PLUGIN_KEY_BYTES: usize = 200;

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidCommand(message.to_owned())
}

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::SetPluginData {
        plugin_id,
        scope,
        scope_id,
        key,
        value_json,
    } = command
    else {
        return Err(mismatch());
    };
    if plugin_id.is_empty() {
        return Err(invalid("plugin_id が空"));
    }
    if key.is_empty() || key.len() > MAX_PLUGIN_KEY_BYTES {
        return Err(invalid("key が空、または長すぎる"));
    }
    if value_json.len() > MAX_PLUGIN_VALUE_BYTES {
        return Err(invalid("value_json が大きすぎる"));
    }
    // `scope = 'project'` のときだけ、`scope_id` が空（DB の CHECK と同じ）。
    if (*scope == PluginScope::Project) != scope_id.is_empty() {
        return Err(invalid("scope と scope_id が合わない"));
    }
    json_text("value_json", value_json)?;
    let now = ctx.now;
    ctx.rec.conn().execute(
        "INSERT INTO plugin_data (plugin_id, scope, scope_id, key, value_json, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
         ON CONFLICT (plugin_id, scope, scope_id, key) \
         DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![plugin_id, scope.as_str(), scope_id, key, value_json, now],
    )?;
    Ok(())
}
