//! アセットのメモ・属性と、アイテムの属性のコマンド（008）。
//!
//! 値が変わらないときは何も書かない（履歴に積まない）。属性の値の検証は、スキーマを知る画面が行う（コアは中身を見ない）。

use rusqlite::types::Value;

use super::apply::Ctx;
use super::items::ensure_item;
use super::rows::{int, mismatch, query_optional, require, text};
use super::validate::json_object;
use super::{Command, Status};
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::SetAssetNote { asset_id, note } => {
            require(ctx.rec.conn(), "assets", asset_id, "アセット")?;
            let current: Option<String> = query_optional(
                ctx.rec.conn(),
                "SELECT note FROM assets WHERE id = ?1",
                [asset_id.as_str()],
            )?
            .flatten();
            if current == *note {
                return Ok(());
            }
            let value = note.as_deref().map_or(Value::Null, text);
            let now = ctx.now;
            ctx.rec.update_columns(
                "assets",
                &[text(asset_id)],
                &[("note", value), ("updated_at", int(now))],
            )
        }
        Command::SetAssetAttributes {
            asset_id,
            attributes_json,
        } => {
            json_object("attributes_json", attributes_json)?;
            require(ctx.rec.conn(), "assets", asset_id, "アセット")?;
            let current: Option<String> = query_optional(
                ctx.rec.conn(),
                "SELECT attributes_json FROM assets WHERE id = ?1",
                [asset_id.as_str()],
            )?;
            if current.as_deref() == Some(attributes_json.as_str()) {
                return Ok(());
            }
            let now = ctx.now;
            ctx.rec.update_columns(
                "assets",
                &[text(asset_id)],
                &[
                    ("attributes_json", text(attributes_json)),
                    ("updated_at", int(now)),
                ],
            )
        }
        Command::SetItemAttributes {
            item,
            attributes_json,
        } => {
            json_object("attributes_json", attributes_json)?;
            require(ctx.rec.conn(), "assets", &item.asset_id, "アセット")?;
            let current: Option<String> = query_optional(
                ctx.rec.conn(),
                "SELECT attributes_json FROM items WHERE asset_id = ?1 AND item_key = ?2",
                [item.asset_id.as_str(), item.item_key.as_str()],
            )?;
            // 行が無いアイテムの属性は、空（`{}`）として扱う。
            if current.as_deref().unwrap_or("{}") == attributes_json.as_str() {
                return Ok(());
            }
            // 行が無ければ、未着手で作る（同じ Undo 単位）。
            let id = ensure_item(ctx, item, Status::Todo)?;
            let now = ctx.now;
            ctx.rec.update_columns(
                "items",
                &[text(&id)],
                &[
                    ("attributes_json", text(attributes_json)),
                    ("updated_at", int(now)),
                ],
            )
        }
        Command::SetAssetMetadata {
            asset_id,
            namespace,
            metadata_json,
        } => {
            let value = namespaced(namespace, metadata_json)?;
            require(ctx.rec.conn(), "assets", asset_id, "アセット")?;
            let current: String = query_optional(
                ctx.rec.conn(),
                "SELECT metadata_json FROM assets WHERE id = ?1",
                [asset_id.as_str()],
            )?
            .unwrap_or_else(|| "{}".to_owned());
            let Some(next) = merged(&current, namespace, &value)? else {
                return Ok(());
            };
            let now = ctx.now;
            ctx.rec.update_columns(
                "assets",
                &[text(asset_id)],
                &[("metadata_json", text(&next)), ("updated_at", int(now))],
            )
        }
        Command::SetItemMetadata {
            item,
            namespace,
            metadata_json,
        } => {
            let value = namespaced(namespace, metadata_json)?;
            require(ctx.rec.conn(), "assets", &item.asset_id, "アセット")?;
            let current: Option<String> = query_optional(
                ctx.rec.conn(),
                "SELECT metadata_json FROM items WHERE asset_id = ?1 AND item_key = ?2",
                [item.asset_id.as_str(), item.item_key.as_str()],
            )?;
            let base = current.clone().unwrap_or_else(|| "{}".to_owned());
            let Some(next) = merged(&base, namespace, &value)? else {
                return Ok(());
            };
            // 行が無ければ、未着手で作る（同じ Undo 単位）。
            let id = ensure_item(ctx, item, Status::Todo)?;
            let now = ctx.now;
            ctx.rec.update_columns(
                "items",
                &[text(&id)],
                &[("metadata_json", text(&next)), ("updated_at", int(now))],
            )
        }
        _ => Err(mismatch()),
    }
}

/// 名前空間が空でなく、値が JSON のオブジェクトであることを確かめて、読んだ値を返す。
fn namespaced(namespace: &str, metadata_json: &str) -> Result<serde_json::Value, StoreError> {
    if namespace.is_empty() {
        return Err(StoreError::InvalidCommand("namespace が空".to_owned()));
    }
    json_object("metadata_json", metadata_json)?;
    serde_json::from_str(metadata_json)
        .map_err(|error| StoreError::InvalidCommand(format!("metadata_json: {error}")))
}

/// `current`（JSON のオブジェクト）の `namespace` を `value` に置き換えた JSON。変わらなければ `None`。
fn merged(
    current: &str,
    namespace: &str,
    value: &serde_json::Value,
) -> Result<Option<String>, StoreError> {
    let mut object: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(current)
    {
        Ok(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    if object.get(namespace) == Some(value) {
        return Ok(None);
    }
    object.insert(namespace.to_owned(), value.clone());
    serde_json::to_string(&serde_json::Value::Object(object))
        .map(Some)
        .map_err(|error| StoreError::InvalidCommand(error.to_string()))
}
