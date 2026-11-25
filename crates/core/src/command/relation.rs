//! 関係（アノテーション同士のリンク）のコマンド。

use rusqlite::types::Value;

use super::Command;
use super::apply::Ctx;
use super::rows::{RowBuilder, boolean, int, mismatch, opt_text, push_field, require, text};
use super::validate::json_object;
use crate::db::tables::RELATIONS;
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::CreateRelation { .. } => create(ctx, command),
        Command::UpdateRelation { .. } => update(ctx, command),
        Command::DeleteRelation { id } => {
            let key = [text(id)];
            ctx.rec
                .delete("relations", &key)
                .map_err(|error| match error {
                    StoreError::NotFound(_) => StoreError::NotFound(format!("関係 {id}")),
                    other => other,
                })
        }
        _ => Err(mismatch()),
    }
}

fn create(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::CreateRelation {
        id,
        relation_type,
        from_id,
        to_id,
        directed,
        label_id,
        attributes_json,
        source,
    } = command
    else {
        return Err(mismatch());
    };
    if from_id == to_id {
        return Err(StoreError::InvalidCommand(
            "関係の両端が同じアノテーション".to_owned(),
        ));
    }
    if let Some(attributes) = attributes_json {
        json_object("attributes_json", attributes)?;
    }
    require(ctx.rec.conn(), "annotations", from_id, "アノテーション")?;
    require(ctx.rec.conn(), "annotations", to_id, "アノテーション")?;
    if let Some(label) = label_id {
        require(ctx.rec.conn(), "labels", label, "ラベル")?;
    }
    let id = ctx.id_or_new(id.as_ref())?;
    let now = ctx.now;
    ctx.rec.insert(
        "relations",
        RowBuilder::new(&RELATIONS)
            .set("id", text(&id))
            .set("type", text(relation_type))
            .set("from_id", text(from_id))
            .set("to_id", text(to_id))
            .set("directed", boolean(directed.unwrap_or(true)))
            .set("label_id", opt_text(label_id.as_deref()))
            .set(
                "attributes_json",
                text(attributes_json.as_deref().unwrap_or("{}")),
            )
            .set("source", text(source.as_deref().unwrap_or("manual")))
            .set("created_at", int(now))
            .set("updated_at", int(now))
            .build(),
    )
}

fn update(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::UpdateRelation { id, patch } = command else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "relations", id, "関係")?;
    let mut changes: Vec<(&'static str, Value)> = Vec::new();
    push_field(&mut changes, "directed", &patch.directed, false, |v| {
        boolean(*v)
    })?;
    push_field(&mut changes, "label_id", &patch.label_id, true, |v| text(v))?;
    push_field(
        &mut changes,
        "attributes_json",
        &patch.attributes_json,
        false,
        |v| text(v),
    )?;
    if changes.is_empty() {
        return Ok(());
    }
    if let super::Field::Set(attributes) = &patch.attributes_json {
        json_object("attributes_json", attributes)?;
    }
    if let super::Field::Set(label) = &patch.label_id {
        require(ctx.rec.conn(), "labels", label, "ラベル")?;
    }
    changes.push(("updated_at", int(ctx.now)));
    ctx.rec.update_columns("relations", &[text(id)], &changes)
}
