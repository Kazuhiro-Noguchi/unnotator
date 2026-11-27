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
        _ => Err(mismatch()),
    }
}
