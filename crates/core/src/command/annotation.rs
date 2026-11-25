//! アノテーション（`core/classification` を含む）のコマンド。

use rusqlite::types::Value;

use super::apply::Ctx;
use super::items::ensure_item;
use super::rows::{RowBuilder, int, mismatch, opt_text, push_field, query_optional, require, text};
use super::validate::{classification_selector, json_object, json_text};
use super::{Command, Status};
use crate::db::tables::ANNOTATIONS;
use crate::error::StoreError;

pub const CLASSIFICATION: &str = "core/classification";

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::CreateAnnotation { .. } => create(ctx, command),
        Command::UpdateAnnotation { .. } => update(ctx, command),
        Command::DeleteAnnotation { .. } => delete(ctx, command),
        _ => Err(mismatch()),
    }
}

fn create(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::CreateAnnotation {
        id,
        target,
        annotation_type,
        type_version,
        selector_json,
        label_id,
        attributes_json,
        summary,
        z_order,
        source,
    } = command
    else {
        return Err(mismatch());
    };

    json_text("selector_json", selector_json)?;
    if annotation_type == CLASSIFICATION {
        classification_selector(selector_json)?;
    }
    if let Some(attributes) = attributes_json {
        json_object("attributes_json", attributes)?;
    }
    require(ctx.rec.conn(), "assets", &target.asset_id, "アセット")?;
    if let Some(label) = label_id {
        require(ctx.rec.conn(), "labels", label, "ラベル")?;
    }
    let item_id = match &target.item {
        Some(item) => {
            if item.asset_id != target.asset_id {
                return Err(StoreError::InvalidCommand(
                    "item の asset_id が target と違う".to_owned(),
                ));
            }
            Some(ensure_item(ctx, item, Status::Todo)?)
        }
        None => None,
    };

    let id = ctx.id_or_new(id.as_ref())?;
    let z_order = match z_order {
        Some(z) => i64::from(*z),
        None => query_optional::<i64>(
            ctx.rec.conn(),
            "SELECT COALESCE(MAX(z_order), -1) + 1 FROM annotations WHERE asset_id = ?1 AND item_id IS ?2",
            rusqlite::params![target.asset_id, item_id],
        )?
        .unwrap_or(0),
    };
    let now = ctx.now;
    ctx.rec.insert(
        "annotations",
        RowBuilder::new(&ANNOTATIONS)
            .set("id", text(&id))
            .set("asset_id", text(&target.asset_id))
            .set("item_id", opt_text(item_id.as_deref()))
            .set("type", text(annotation_type))
            .set("type_version", int(i64::from(type_version.unwrap_or(1))))
            .set("selector_json", text(selector_json))
            .set("label_id", opt_text(label_id.as_deref()))
            .set(
                "attributes_json",
                text(attributes_json.as_deref().unwrap_or("{}")),
            )
            .set("summary", text(summary.as_deref().unwrap_or("")))
            .set("z_order", int(z_order))
            .set("source", text(source.as_deref().unwrap_or("manual")))
            .set("created_at", int(now))
            .set("updated_at", int(now))
            .build(),
    )
}

fn update(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::UpdateAnnotation { id, patch } = command else {
        return Err(mismatch());
    };
    let key = [text(id)];
    let existing = ctx
        .rec
        .get("annotations", &key)?
        .ok_or_else(|| StoreError::NotFound(format!("アノテーション {id}")))?;
    let type_index = ANNOTATIONS.column_index("type").unwrap_or(3);
    let is_classification = existing.get(type_index) == Some(&text(CLASSIFICATION));

    let mut changes: Vec<(&'static str, Value)> = Vec::new();
    push_field(
        &mut changes,
        "type_version",
        &patch.type_version,
        false,
        |v| int(i64::from(*v)),
    )?;
    push_field(
        &mut changes,
        "selector_json",
        &patch.selector_json,
        false,
        |v| text(v),
    )?;
    push_field(&mut changes, "label_id", &patch.label_id, true, |v| text(v))?;
    push_field(
        &mut changes,
        "attributes_json",
        &patch.attributes_json,
        false,
        |v| text(v),
    )?;
    push_field(&mut changes, "summary", &patch.summary, false, |v| text(v))?;
    push_field(&mut changes, "z_order", &patch.z_order, false, |v| {
        int(i64::from(*v))
    })?;
    if changes.is_empty() {
        return Ok(());
    }

    if let super::Field::Set(selector) = &patch.selector_json {
        json_text("selector_json", selector)?;
        if is_classification {
            classification_selector(selector)?;
        }
    }
    if let super::Field::Set(attributes) = &patch.attributes_json {
        json_object("attributes_json", attributes)?;
    }
    if let super::Field::Set(label) = &patch.label_id {
        require(ctx.rec.conn(), "labels", label, "ラベル")?;
    }
    changes.push(("updated_at", int(ctx.now)));
    ctx.rec.update_columns("annotations", &key, &changes)
}

fn delete(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::DeleteAnnotation { id } = command else {
        return Err(mismatch());
    };
    let key = [text(id)];
    if ctx.rec.get("annotations", &key)?.is_none() {
        return Err(StoreError::NotFound(format!("アノテーション {id}")));
    }
    // US4 で連鎖削除を実装するまでの保護。SQLite の ON DELETE CASCADE に頼ると、記録されない削除が起きる。
    let dependents: i64 = ctx.rec.conn().query_row(
        "SELECT (SELECT count(*) FROM relations WHERE from_id = ?1 OR to_id = ?1) \
              + (SELECT count(*) FROM group_members WHERE annotation_id = ?1)",
        [id.as_str()],
        |row| row.get(0),
    )?;
    if dependents > 0 {
        return Err(StoreError::InvalidCommand(
            "関係またはグループに含まれている（連鎖削除は未実装）".to_owned(),
        ));
    }
    ctx.rec.delete("annotations", &key)
}
