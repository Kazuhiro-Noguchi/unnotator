//! アイテム（アセットの分割単位）の行。状態・属性・アノテーションのいずれかが付くときにだけ作る。

use super::apply::Ctx;
use super::rows::{RowBuilder, query_optional, require, text};
use super::{ItemRef, Status};
use crate::db::tables::ITEMS;
use crate::error::StoreError;

/// アイテムの ID を返す。行が無ければ、同じ Undo 単位で作る。
pub fn ensure_item(
    ctx: &mut Ctx<'_>,
    item: &ItemRef,
    status: Status,
) -> Result<String, StoreError> {
    require(ctx.rec.conn(), "assets", &item.asset_id, "アセット")?;
    let existing: Option<String> = query_optional(
        ctx.rec.conn(),
        "SELECT id FROM items WHERE asset_id = ?1 AND item_key = ?2",
        [item.asset_id.as_str(), item.item_key.as_str()],
    )?;
    if let Some(id) = existing {
        return Ok(id);
    }
    let id = ctx.new_id()?;
    let now = ctx.now;
    ctx.rec.insert(
        "items",
        RowBuilder::new(&ITEMS)
            .set("id", text(&id))
            .set("asset_id", text(&item.asset_id))
            .set("item_key", text(&item.item_key))
            .set("provider", text(&item.provider))
            .set("status", text(status.as_str()))
            .set("metadata_json", text("{}"))
            .set("attributes_json", text("{}"))
            .set("created_at", super::rows::int(now))
            .set("updated_at", super::rows::int(now))
            .build(),
    )?;
    Ok(id)
}
