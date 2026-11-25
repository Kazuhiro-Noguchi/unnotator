//! ラベルのコマンド。

use rusqlite::Connection;
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

use super::annotation::delete_cascade;
use super::apply::Ctx;
use super::group::delete_group;
use super::rows::{
    RowBuilder, boolean, int, mismatch, push_field, query_ids, query_optional, require, text,
};
use super::validate::json_object;
use super::{Command, LabelDisposition};
use crate::db::tables::LABELS;
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::CreateLabel { .. } => create(ctx, command),
        Command::UpdateLabel { .. } => update(ctx, command),
        Command::DeleteLabel { id, disposition } => delete(ctx, id, disposition.as_ref()),
        _ => Err(mismatch()),
    }
}

fn create(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::CreateLabel {
        id,
        name,
        name_i18n_json,
        color,
        hotkey,
        sort_order,
        hidden,
        applies_to_json,
    } = command
    else {
        return Err(mismatch());
    };
    if let Some(json) = name_i18n_json {
        json_object("name_i18n_json", json)?;
    }
    if let Some(json) = applies_to_json {
        json_object("applies_to_json", json)?;
    }
    let id = ctx.id_or_new(id.as_ref())?;
    let now = ctx.now;
    ctx.rec.insert(
        "labels",
        RowBuilder::new(&LABELS)
            .set("id", text(&id))
            .set("name", text(name))
            .set(
                "name_i18n_json",
                text(name_i18n_json.as_deref().unwrap_or("{}")),
            )
            .set("color", text(color))
            .set("hotkey", hotkey.map_or(Value::Null, |h| int(i64::from(h))))
            .set("sort_order", int(i64::from(sort_order.unwrap_or(0))))
            .set("hidden", boolean(hidden.unwrap_or(false)))
            .set(
                "applies_to_json",
                text(applies_to_json.as_deref().unwrap_or("{}")),
            )
            .set("created_at", int(now))
            .set("updated_at", int(now))
            .build(),
    )
}

fn update(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::UpdateLabel { id, patch } = command else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "labels", id, "ラベル")?;
    let mut changes: Vec<(&'static str, Value)> = Vec::new();
    push_field(&mut changes, "name", &patch.name, false, |v| text(v))?;
    push_field(
        &mut changes,
        "name_i18n_json",
        &patch.name_i18n_json,
        false,
        |v| text(v),
    )?;
    push_field(&mut changes, "color", &patch.color, false, |v| text(v))?;
    push_field(&mut changes, "hotkey", &patch.hotkey, true, |v| {
        int(i64::from(*v))
    })?;
    push_field(&mut changes, "sort_order", &patch.sort_order, false, |v| {
        int(i64::from(*v))
    })?;
    push_field(&mut changes, "hidden", &patch.hidden, false, |v| {
        boolean(*v)
    })?;
    push_field(
        &mut changes,
        "applies_to_json",
        &patch.applies_to_json,
        false,
        |v| text(v),
    )?;
    if changes.is_empty() {
        return Ok(());
    }
    if let super::Field::Set(json) = &patch.name_i18n_json {
        json_object("name_i18n_json", json)?;
    }
    if let super::Field::Set(json) = &patch.applies_to_json {
        json_object("applies_to_json", json)?;
    }
    changes.push(("updated_at", int(ctx.now)));
    ctx.rec.update_columns("labels", &[text(id)], &changes)
}

/// ラベルを使っているものの件数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LabelUsage {
    pub annotations: u32,
    pub relations: u32,
    pub groups: u32,
    /// そのラベル専用の属性スキーマ（`scope = 'label'`）。
    pub attribute_schemas: u32,
}

fn count(conn: &Connection, sql: &str, id: &str) -> Result<u32, StoreError> {
    let n: Option<i64> = query_optional(conn, sql, [id])?;
    Ok(u32::try_from(n.unwrap_or(0)).unwrap_or(u32::MAX))
}

/// ラベルの使用件数。ラベルが無ければ `NotFound`。
pub fn usage(conn: &Connection, id: &str) -> Result<LabelUsage, StoreError> {
    require(conn, "labels", id, "ラベル")?;
    Ok(LabelUsage {
        annotations: count(
            conn,
            "SELECT count(*) FROM annotations WHERE label_id = ?1",
            id,
        )?,
        relations: count(
            conn,
            "SELECT count(*) FROM relations WHERE label_id = ?1",
            id,
        )?,
        groups: count(
            conn,
            "SELECT count(*) FROM annotation_groups WHERE label_id = ?1",
            id,
        )?,
        attribute_schemas: count(
            conn,
            "SELECT count(*) FROM attribute_schemas WHERE scope = 'label' AND target = ?1",
            id,
        )?,
    })
}

/// 使っているものを、指定どおりに付け替えるか一緒に削除してから、ラベルを削除する。
/// そのラベル専用の属性スキーマも同じ Undo 単位で削除する（契約に外部キーが無いので、コアが整合させる）。
fn delete(
    ctx: &mut Ctx<'_>,
    id: &str,
    disposition: Option<&LabelDisposition>,
) -> Result<(), StoreError> {
    let usage = usage(ctx.rec.conn(), id)?;
    let used = usage.annotations + usage.relations + usage.groups;
    if used > 0 && disposition.is_none() {
        return Err(StoreError::LabelInUse {
            annotations: u64::from(usage.annotations),
            relations: u64::from(usage.relations),
            groups: u64::from(usage.groups),
        });
    }

    match disposition {
        None => {}
        Some(LabelDisposition::Reassign { to_label_id }) => {
            if to_label_id == id {
                return Err(StoreError::InvalidCommand(
                    "付け替え先が削除するラベルと同じ".to_owned(),
                ));
            }
            require(ctx.rec.conn(), "labels", to_label_id, "付け替え先のラベル")?;
            let now = ctx.now;
            for (table, sql) in [
                (
                    "annotations",
                    "SELECT id FROM annotations WHERE label_id = ?1 ORDER BY id",
                ),
                (
                    "relations",
                    "SELECT id FROM relations WHERE label_id = ?1 ORDER BY id",
                ),
                (
                    "annotation_groups",
                    "SELECT id FROM annotation_groups WHERE label_id = ?1 ORDER BY id",
                ),
            ] {
                for row_id in query_ids(ctx.rec.conn(), sql, [id])? {
                    ctx.rec.update_columns(
                        table,
                        &[text(&row_id)],
                        &[("label_id", text(to_label_id)), ("updated_at", int(now))],
                    )?;
                }
            }
        }
        Some(LabelDisposition::Cascade) => {
            for annotation in query_ids(
                ctx.rec.conn(),
                "SELECT id FROM annotations WHERE label_id = ?1 ORDER BY id",
                [id],
            )? {
                delete_cascade(ctx, &annotation)?;
            }
            // アノテーションの連鎖で消えた関係を除いた、残りの関係
            for relation in query_ids(
                ctx.rec.conn(),
                "SELECT id FROM relations WHERE label_id = ?1 ORDER BY id",
                [id],
            )? {
                ctx.rec.delete("relations", &[text(&relation)])?;
            }
            for group in query_ids(
                ctx.rec.conn(),
                "SELECT id FROM annotation_groups WHERE label_id = ?1 ORDER BY id",
                [id],
            )? {
                delete_group(ctx, &group)?;
            }
        }
    }

    for schema in query_ids(
        ctx.rec.conn(),
        "SELECT id FROM attribute_schemas WHERE scope = 'label' AND target = ?1 ORDER BY id",
        [id],
    )? {
        ctx.rec.delete("attribute_schemas", &[text(&schema)])?;
    }
    ctx.rec.delete("labels", &[text(id)])
}
