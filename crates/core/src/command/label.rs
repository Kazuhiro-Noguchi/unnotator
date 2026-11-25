//! ラベルのコマンド。

use rusqlite::types::Value;

use super::Command;
use super::apply::Ctx;
use super::rows::{RowBuilder, boolean, int, mismatch, push_field, require, text};
use super::validate::json_object;
use crate::db::tables::LABELS;
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::CreateLabel { .. } => create(ctx, command),
        Command::UpdateLabel { .. } => update(ctx, command),
        // 使用中のラベルの削除（付け替え・一緒に削除）は US4 で実装する。
        Command::DeleteLabel { .. } => Err(StoreError::InvalidCommand(
            "DeleteLabel は未実装".to_owned(),
        )),
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
