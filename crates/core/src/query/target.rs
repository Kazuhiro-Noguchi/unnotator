//! 現在位置（アセット、またはアイテム）の詳細（`TargetDetails`）。

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::page::{AnnotationRow, COLUMNS, row_of};
use crate::command::Status;
use crate::error::StoreError;

/// 関係とグループの上限（ページングしない）。
pub const LINK_LIMIT: u32 = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AssetDetails {
    pub id: String,
    pub root_key: String,
    pub rel_path: String,
    pub media_type: Option<String>,
    pub missing: bool,
    pub status: Status,
    pub note: Option<String>,
    pub attributes_json: String,
}

/// アイテムの行（無ければ `None`。記録の無いアイテムは未着手として扱う）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ItemDetails {
    pub id: String,
    pub item_key: String,
    pub provider: String,
    pub status: Status,
    pub attributes_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RelationRow {
    pub id: String,
    #[serde(rename = "type")]
    pub relation_type: String,
    pub from_id: String,
    pub to_id: String,
    pub directed: bool,
    pub label_id: Option<String>,
    pub attributes_json: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct GroupRow {
    pub id: String,
    #[serde(rename = "type")]
    pub group_type: String,
    pub ordered: bool,
    pub label_id: Option<String>,
    pub attributes_json: String,
    pub source: String,
    /// `position` 順のアノテーション ID。
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct TargetDetails {
    pub asset: AssetDetails,
    pub item: Option<ItemDetails>,
    /// 現在位置の `core/classification`。
    pub classification: Vec<AnnotationRow>,
    pub annotation_count: u32,
    pub relations: Vec<RelationRow>,
    pub groups: Vec<GroupRow>,
}

fn status_of(text: &str) -> Status {
    Status::parse(text).unwrap_or(Status::Todo)
}

/// アセット（`item_key` が `None`）、またはアイテムの詳細。アセットが無いときは `None`。
pub fn target_details(
    conn: &Connection,
    asset_id: &str,
    item_key: Option<&str>,
) -> Result<Option<TargetDetails>, StoreError> {
    let asset = conn
        .query_row(
            "SELECT id, root_key, rel_path, media_type, missing, status, note, attributes_json \
             FROM assets WHERE id = ?1",
            [asset_id],
            |row| {
                Ok(AssetDetails {
                    id: row.get(0)?,
                    root_key: row.get(1)?,
                    rel_path: row.get(2)?,
                    media_type: row.get(3)?,
                    missing: row.get::<_, i64>(4)? != 0,
                    status: status_of(&row.get::<_, String>(5)?),
                    note: row.get(6)?,
                    attributes_json: row.get(7)?,
                })
            },
        )
        .optional()?;
    let Some(asset) = asset else {
        return Ok(None);
    };
    let item = match item_key {
        None => None,
        Some(key) => conn
            .query_row(
                "SELECT id, item_key, provider, status, attributes_json FROM items \
                 WHERE asset_id = ?1 AND item_key = ?2",
                [asset_id, key],
                |row| {
                    Ok(ItemDetails {
                        id: row.get(0)?,
                        item_key: row.get(1)?,
                        provider: row.get(2)?,
                        status: status_of(&row.get::<_, String>(3)?),
                        attributes_json: row.get(4)?,
                    })
                },
            )
            .optional()?,
    };
    // アイテムを指定されたが行が無い: その位置のアノテーションは無い。
    let scope_item: Option<&str> = item.as_ref().map(|i| i.id.as_str());
    let no_scope = item_key.is_some() && item.is_none();

    let (classification, annotation_count, relations, groups) = if no_scope {
        (Vec::new(), 0, Vec::new(), Vec::new())
    } else {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM annotations \
             WHERE asset_id = ?1 AND item_id IS ?2 AND type = 'core/classification' \
             ORDER BY z_order, id"
        ))?;
        let classification = stmt
            .query_map(rusqlite::params![asset_id, scope_item], row_of)?
            .collect::<Result<Vec<_>, _>>()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM annotations WHERE asset_id = ?1 AND item_id IS ?2",
            rusqlite::params![asset_id, scope_item],
            |r| r.get(0),
        )?;
        let in_scope = "SELECT id FROM annotations WHERE asset_id = ?1 AND item_id IS ?2";
        let mut stmt = conn.prepare(&format!(
            "SELECT id, type, from_id, to_id, directed, label_id, attributes_json, source FROM relations \
             WHERE from_id IN ({in_scope}) OR to_id IN ({in_scope}) ORDER BY created_at, id LIMIT ?3"
        ))?;
        let relations = stmt
            .query_map(rusqlite::params![asset_id, scope_item, LINK_LIMIT], |row| {
                Ok(RelationRow {
                    id: row.get(0)?,
                    relation_type: row.get(1)?,
                    from_id: row.get(2)?,
                    to_id: row.get(3)?,
                    directed: row.get::<_, i64>(4)? != 0,
                    label_id: row.get(5)?,
                    attributes_json: row.get(6)?,
                    source: row.get(7)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut stmt = conn.prepare(&format!(
            "SELECT id, type, ordered, label_id, attributes_json, source FROM annotation_groups \
             WHERE id IN (SELECT group_id FROM group_members WHERE annotation_id IN ({in_scope})) \
             ORDER BY created_at, id LIMIT ?3"
        ))?;
        let mut groups = stmt
            .query_map(rusqlite::params![asset_id, scope_item, LINK_LIMIT], |row| {
                Ok(GroupRow {
                    id: row.get(0)?,
                    group_type: row.get(1)?,
                    ordered: row.get::<_, i64>(2)? != 0,
                    label_id: row.get(3)?,
                    attributes_json: row.get(4)?,
                    source: row.get(5)?,
                    members: Vec::new(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut members = conn.prepare(
            "SELECT annotation_id FROM group_members WHERE group_id = ?1 ORDER BY position, annotation_id",
        )?;
        for group in &mut groups {
            group.members = members
                .query_map([&group.id], |r| r.get(0))?
                .collect::<Result<_, _>>()?;
        }
        (
            classification,
            u32::try_from(count).unwrap_or(u32::MAX),
            relations,
            groups,
        )
    };
    Ok(Some(TargetDetails {
        asset,
        item,
        classification,
        annotation_count,
        relations,
        groups,
    }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::super::page::tests::{add, db_with_asset};
    use super::*;

    #[test]
    fn a_missing_asset_has_no_details() {
        assert!(
            target_details(&db_with_asset(), "nope", None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn asset_details_carry_status_note_and_attributes() {
        let conn = db_with_asset();
        conn.execute(
            "UPDATE assets SET status = 'review', note = 'memo', attributes_json = '{\"k\":1}' WHERE id = 'a1'",
            [],
        )
        .unwrap();
        let d = target_details(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(d.asset.status, Status::Review);
        assert_eq!(d.asset.note.as_deref(), Some("memo"));
        assert_eq!(d.asset.attributes_json, "{\"k\":1}");
        assert!(d.item.is_none());
        assert_eq!(d.annotation_count, 0);
    }

    #[test]
    fn counts_and_classification_cover_only_the_asset_level() {
        let conn = db_with_asset();
        conn.execute(
            "INSERT INTO items (id, asset_id, item_key, provider, status, created_at, updated_at) \
             VALUES ('i1', 'a1', 'page:1', 'p/x', 'done', 0, 0)",
            [],
        )
        .unwrap();
        add(&conn, "c", "a1", None, "core/classification", 0);
        add(&conn, "s", "a1", None, "com.example.shape/shape", 1);
        add(&conn, "ic", "a1", Some("i1"), "core/classification", 0);
        let asset = target_details(&conn, "a1", None).unwrap().unwrap();
        assert_eq!(asset.annotation_count, 2);
        assert_eq!(asset.classification.len(), 1);
        assert_eq!(asset.classification[0].id, "c");
        let item = target_details(&conn, "a1", Some("page:1"))
            .unwrap()
            .unwrap();
        assert_eq!(item.item.as_ref().unwrap().status, Status::Done);
        assert_eq!(item.annotation_count, 1);
        assert_eq!(item.classification[0].id, "ic");
        // 行の無いアイテムは、アノテーションが無い
        let none = target_details(&conn, "a1", Some("page:9"))
            .unwrap()
            .unwrap();
        assert!(none.item.is_none());
        assert_eq!(none.annotation_count, 0);
    }

    #[test]
    fn relations_and_groups_touching_the_scope_are_returned_with_members_in_order() {
        let conn = db_with_asset();
        add(&conn, "x", "a1", None, "t/t", 0);
        add(&conn, "y", "a2", None, "t/t", 0);
        add(&conn, "z", "a2", None, "t/t", 1);
        conn.execute(
            "INSERT INTO relations (id, type, from_id, to_id, created_at, updated_at) \
             VALUES ('r1', 't/r', 'x', 'y', 0, 0), ('r2', 't/r', 'y', 'z', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO annotation_groups (id, type, ordered, created_at, updated_at) VALUES ('g1', 't/g', 1, 0, 0), ('g2', 't/g', 0, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_members (group_id, annotation_id, position) VALUES ('g1', 'y', 1), ('g1', 'x', 0), ('g2', 'z', 0)",
            [],
        )
        .unwrap();
        let d = target_details(&conn, "a1", None).unwrap().unwrap();
        // x に触れる関係・グループだけ。別アセットの y とも結べる。
        assert_eq!(d.relations.len(), 1);
        assert_eq!(d.relations[0].id, "r1");
        assert_eq!(d.groups.len(), 1);
        assert_eq!(d.groups[0].members, ["x", "y"]);
        assert!(d.groups[0].ordered);
    }
}
