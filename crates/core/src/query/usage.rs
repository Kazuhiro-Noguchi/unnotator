//! 属性スキーマの影響の件数。スキーマを変える前に、値が入っているものの数を知らせるため。
//!
//! 属性の値は消さない。件数は確認のための情報で、`attributes_json` に指定の名前のキーを持つ行を数える。

use rusqlite::Connection;

use crate::command::AttributeScope;
use crate::error::StoreError;

/// `names` のどれかをキーに持つ `attributes_json` の行の数。対象は、スキーマの `scope`・`target` が決める。
pub fn attribute_usage(
    conn: &Connection,
    scope: AttributeScope,
    target: &str,
    names: &[String],
) -> Result<u32, StoreError> {
    if names.is_empty() {
        return Ok(0);
    }
    let marks = vec!["?"; names.len()].join(", ");
    let has_key = format!(
        "EXISTS (SELECT 1 FROM json_each(attributes_json) WHERE json_each.key IN ({marks}))"
    );
    // 絞り込み（対象の列と値）。`global` は、アノテーションすべて。
    let (table, filter): (&str, Option<(&str, &str)>) = match scope {
        AttributeScope::Global => ("annotations", None),
        AttributeScope::Label => ("annotations", Some(("label_id", target))),
        AttributeScope::AnnotationType => ("annotations", Some(("type", target))),
        AttributeScope::RelationType => ("relations", Some(("type", target))),
        AttributeScope::GroupType => ("annotation_groups", Some(("type", target))),
        AttributeScope::Asset => (
            "assets",
            (!target.is_empty()).then_some(("media_type", target)),
        ),
        AttributeScope::Item => (
            "items",
            (!target.is_empty()).then_some(("provider", target)),
        ),
    };
    let mut sql = format!("SELECT COUNT(*) FROM {table} WHERE {has_key}");
    let mut params: Vec<&str> = names.iter().map(String::as_str).collect();
    if let Some((column, value)) = filter {
        sql.push_str(&format!(" AND {column} = ?"));
        params.push(value);
    }
    let count: i64 = conn.query_row(&sql, rusqlite::params_from_iter(params), |r| r.get(0))?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::super::page::tests::{add, db_with_asset};
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn counts_rows_that_hold_a_value_for_the_named_properties() {
        let conn = db_with_asset();
        add(&conn, "x", "a1", None, "t/shape", 0);
        add(&conn, "y", "a1", None, "t/shape", 1);
        add(&conn, "z", "a2", None, "t/other", 0);
        conn.execute(
            "UPDATE annotations SET attributes_json = '{\"age\":\"adult\"}' WHERE id IN ('x', 'z')",
            [],
        )
        .unwrap();
        let count = |scope, target: &str, list: &[&str]| {
            attribute_usage(&conn, scope, target, &names(list)).unwrap()
        };
        assert_eq!(count(AttributeScope::Global, "", &["age"]), 2);
        assert_eq!(
            count(AttributeScope::AnnotationType, "t/shape", &["age"]),
            1
        );
        assert_eq!(
            count(AttributeScope::AnnotationType, "t/shape", &["nope"]),
            0
        );
        assert_eq!(count(AttributeScope::Global, "", &["nope", "age"]), 2);
        assert_eq!(count(AttributeScope::Global, "", &[]), 0);
    }

    #[test]
    fn label_asset_and_item_scopes_filter_by_their_target() {
        let conn = db_with_asset();
        conn.execute(
            "INSERT INTO labels (id, name, color, created_at, updated_at) VALUES ('l1', 'cat', '#112233', 0, 0)",
            [],
        )
        .unwrap();
        add(&conn, "x", "a1", None, "t/t", 0);
        conn.execute(
            "UPDATE annotations SET label_id = 'l1', attributes_json = '{\"k\":1}' WHERE id = 'x'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE assets SET media_type = 'x/image', attributes_json = '{\"k\":1}' WHERE id = 'a1'",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO items (id, asset_id, item_key, provider, attributes_json, created_at, updated_at) \
             VALUES ('i1', 'a1', 'p:1', 'p/pages', '{\"k\":1}', 0, 0)",
            [],
        )
        .unwrap();
        let count =
            |scope, target: &str| attribute_usage(&conn, scope, target, &names(&["k"])).unwrap();
        assert_eq!(count(AttributeScope::Label, "l1"), 1);
        assert_eq!(count(AttributeScope::Label, "other"), 0);
        assert_eq!(count(AttributeScope::Asset, ""), 1);
        assert_eq!(count(AttributeScope::Asset, "x/image"), 1);
        assert_eq!(count(AttributeScope::Asset, "x/audio"), 0);
        assert_eq!(count(AttributeScope::Item, "p/pages"), 1);
        assert_eq!(count(AttributeScope::Item, ""), 1);
    }
}
