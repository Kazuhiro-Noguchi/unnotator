//! アセットとアイテムの作業状態のコマンド。

use super::Command;
use super::apply::Ctx;
use super::items::ensure_item;
use super::rows::{int, mismatch, query_optional, require, text};
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::SetAssetStatus { asset_id, status } => {
            require(ctx.rec.conn(), "assets", asset_id, "アセット")?;
            let now = ctx.now;
            ctx.rec.update_columns(
                "assets",
                &[text(asset_id)],
                &[("status", text(status.as_str())), ("updated_at", int(now))],
            )
        }
        Command::SetItemStatus { item, status } => {
            let existing: Option<String> = query_optional(
                ctx.rec.conn(),
                "SELECT id FROM items WHERE asset_id = ?1 AND item_key = ?2",
                [item.asset_id.as_str(), item.item_key.as_str()],
            )?;
            // 行が無ければ、この状態で作る。
            let id = ensure_item(ctx, item, *status)?;
            if existing.is_some() {
                let now = ctx.now;
                ctx.rec.update_columns(
                    "items",
                    &[text(&id)],
                    &[("status", text(status.as_str())), ("updated_at", int(now))],
                )?;
            }
            Ok(())
        }
        _ => Err(mismatch()),
    }
}
