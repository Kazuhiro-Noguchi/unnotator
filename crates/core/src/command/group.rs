//! グループ（アノテーションの集合）のコマンド。メンバーの `position` は 0 から連続させる。

use rusqlite::types::Value;

use super::Command;
use super::apply::Ctx;
use super::rows::{RowBuilder, boolean, int, mismatch, opt_text, push_field, require, text};
use super::validate::json_object;
use crate::db::tables::{ANNOTATION_GROUPS, GROUP_MEMBERS};
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::CreateGroup { .. } => create(ctx, command),
        Command::UpdateGroup { .. } => update(ctx, command),
        Command::DeleteGroup { .. } => delete(ctx, command),
        Command::AddGroupMembers { .. } => add_members(ctx, command),
        Command::RemoveGroupMembers { .. } => remove_members(ctx, command),
        Command::MoveGroupMember { .. } => move_member(ctx, command),
        _ => Err(mismatch()),
    }
}

/// いまのメンバーを、位置の順に返す。
fn current_members(ctx: &Ctx<'_>, group_id: &str) -> Result<Vec<String>, StoreError> {
    let mut stmt = ctx.rec.conn().prepare_cached(
        "SELECT annotation_id FROM group_members WHERE group_id = ?1 ORDER BY position, annotation_id",
    )?;
    let rows = stmt.query_map([group_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// `order` の並びになるよう、位置を 0.. で付け直す。無いメンバーは追加する。
fn renumber(ctx: &mut Ctx<'_>, group_id: &str, order: &[String]) -> Result<(), StoreError> {
    for (index, annotation_id) in order.iter().enumerate() {
        let position = i64::try_from(index).unwrap_or(i64::MAX);
        let key = [text(group_id), text(annotation_id)];
        if ctx.rec.get("group_members", &key)?.is_some() {
            ctx.rec
                .update_columns("group_members", &key, &[("position", int(position))])?;
        } else {
            ctx.rec.insert(
                "group_members",
                RowBuilder::new(&GROUP_MEMBERS)
                    .set("group_id", text(group_id))
                    .set("annotation_id", text(annotation_id))
                    .set("position", int(position))
                    .build(),
            )?;
        }
    }
    Ok(())
}

fn check_distinct(ids: &[String]) -> Result<(), StoreError> {
    let mut seen = std::collections::HashSet::new();
    if ids.iter().all(|id| seen.insert(id)) {
        Ok(())
    } else {
        Err(StoreError::InvalidCommand(
            "メンバーが重複している".to_owned(),
        ))
    }
}

fn create(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::CreateGroup {
        id,
        group_type,
        ordered,
        label_id,
        attributes_json,
        members,
        source,
    } = command
    else {
        return Err(mismatch());
    };
    if let Some(attributes) = attributes_json {
        json_object("attributes_json", attributes)?;
    }
    if let Some(label) = label_id {
        require(ctx.rec.conn(), "labels", label, "ラベル")?;
    }
    check_distinct(members)?;
    for member in members {
        require(ctx.rec.conn(), "annotations", member, "アノテーション")?;
    }
    let id = ctx.id_or_new(id.as_ref())?;
    let now = ctx.now;
    ctx.rec.insert(
        "annotation_groups",
        RowBuilder::new(&ANNOTATION_GROUPS)
            .set("id", text(&id))
            .set("type", text(group_type))
            .set("ordered", boolean(ordered.unwrap_or(false)))
            .set("label_id", opt_text(label_id.as_deref()))
            .set(
                "attributes_json",
                text(attributes_json.as_deref().unwrap_or("{}")),
            )
            .set("source", text(source.as_deref().unwrap_or("manual")))
            .set("created_at", int(now))
            .set("updated_at", int(now))
            .build(),
    )?;
    renumber(ctx, &id, members)
}

fn update(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::UpdateGroup { id, patch } = command else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "annotation_groups", id, "グループ")?;
    let mut changes: Vec<(&'static str, Value)> = Vec::new();
    push_field(&mut changes, "ordered", &patch.ordered, false, |v| {
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
    ctx.rec
        .update_columns("annotation_groups", &[text(id)], &changes)
}

fn delete(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::DeleteGroup { id } = command else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "annotation_groups", id, "グループ")?;
    for member in current_members(ctx, id)? {
        ctx.rec
            .delete("group_members", &[text(id), text(&member)])?;
    }
    ctx.rec.delete("annotation_groups", &[text(id)])
}

fn add_members(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::AddGroupMembers {
        group_id,
        annotation_ids,
        at,
    } = command
    else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "annotation_groups", group_id, "グループ")?;
    check_distinct(annotation_ids)?;
    let current = current_members(ctx, group_id)?;
    for annotation in annotation_ids {
        require(ctx.rec.conn(), "annotations", annotation, "アノテーション")?;
        if current.contains(annotation) {
            return Err(StoreError::InvalidCommand(format!(
                "すでにメンバーです: {annotation}"
            )));
        }
    }
    let index = at
        .map(|a| usize::try_from(a).unwrap_or(usize::MAX))
        .map_or(current.len(), |a| a.min(current.len()));
    let mut order = current;
    order.splice(index..index, annotation_ids.iter().cloned());
    renumber(ctx, group_id, &order)
}

fn remove_members(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::RemoveGroupMembers {
        group_id,
        annotation_ids,
    } = command
    else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "annotation_groups", group_id, "グループ")?;
    check_distinct(annotation_ids)?;
    let current = current_members(ctx, group_id)?;
    for annotation in annotation_ids {
        if !current.contains(annotation) {
            return Err(StoreError::NotFound(format!(
                "グループのメンバー {annotation}"
            )));
        }
        ctx.rec
            .delete("group_members", &[text(group_id), text(annotation)])?;
    }
    let remaining: Vec<String> = current
        .into_iter()
        .filter(|a| !annotation_ids.contains(a))
        .collect();
    renumber(ctx, group_id, &remaining)
}

fn move_member(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    let Command::MoveGroupMember {
        group_id,
        annotation_id,
        to_position,
    } = command
    else {
        return Err(mismatch());
    };
    require(ctx.rec.conn(), "annotation_groups", group_id, "グループ")?;
    let mut order = current_members(ctx, group_id)?;
    let Some(from) = order.iter().position(|a| a == annotation_id) else {
        return Err(StoreError::NotFound(format!(
            "グループのメンバー {annotation_id}"
        )));
    };
    let member = order.remove(from);
    let to = usize::try_from(*to_position)
        .unwrap_or(usize::MAX)
        .min(order.len());
    order.insert(to, member);
    renumber(ctx, group_id, &order)
}
