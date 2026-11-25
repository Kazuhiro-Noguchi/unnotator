//! 属性スキーマのコマンド。`(scope, target)` で一意。

use super::apply::Ctx;
use super::rows::{RowBuilder, int, mismatch, query_optional, require, text};
use super::validate::attribute_schema;
use super::{AttributeScope, Command};
use crate::db::tables::ATTRIBUTE_SCHEMAS;
use crate::error::StoreError;

pub fn handle(ctx: &mut Ctx<'_>, command: &Command) -> Result<(), StoreError> {
    match command {
        Command::SetAttributeSchema {
            scope,
            target,
            schema_json,
        } => set(ctx, *scope, target, schema_json),
        Command::DeleteAttributeSchema { scope, target } => delete(ctx, *scope, target),
        _ => Err(mismatch()),
    }
}

fn find(ctx: &Ctx<'_>, scope: AttributeScope, target: &str) -> Result<Option<String>, StoreError> {
    query_optional(
        ctx.rec.conn(),
        "SELECT id FROM attribute_schemas WHERE scope = ?1 AND target = ?2",
        [scope.as_str(), target],
    )
}

fn set(
    ctx: &mut Ctx<'_>,
    scope: AttributeScope,
    target: &str,
    schema_json: &str,
) -> Result<(), StoreError> {
    attribute_schema(schema_json)?;
    if scope == AttributeScope::Label {
        require(ctx.rec.conn(), "labels", target, "ラベル")?;
    }
    let now = ctx.now;
    if let Some(id) = find(ctx, scope, target)? {
        ctx.rec.update_columns(
            "attribute_schemas",
            &[text(&id)],
            &[("schema_json", text(schema_json)), ("updated_at", int(now))],
        )
    } else {
        let id = ctx.new_id()?;
        ctx.rec.insert(
            "attribute_schemas",
            RowBuilder::new(&ATTRIBUTE_SCHEMAS)
                .set("id", text(&id))
                .set("scope", text(scope.as_str()))
                .set("target", text(target))
                .set("schema_json", text(schema_json))
                .set("updated_at", int(now))
                .build(),
        )
    }
}

fn delete(ctx: &mut Ctx<'_>, scope: AttributeScope, target: &str) -> Result<(), StoreError> {
    let id = find(ctx, scope, target)?
        .ok_or_else(|| StoreError::NotFound(format!("属性スキーマ {}/{target}", scope.as_str())))?;
    ctx.rec.delete("attribute_schemas", &[text(&id)])
}
