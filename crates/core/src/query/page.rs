//! アノテーション一覧のページ（`AnnotationRow`・`AnnotationPage`）。`selector_json` は含めない。

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::StoreError;

/// 1 ページの件数。
pub const PAGE_SIZE: u32 = 500;

/// `annotations` の 1 行（位置の指定 `selector_json` は含めない。コアは読まない）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AnnotationRow {
    pub id: String,
    #[serde(rename = "type")]
    pub annotation_type: String,
    pub type_version: u32,
    pub label_id: Option<String>,
    pub attributes_json: String,
    pub summary: String,
    pub z_order: i32,
    pub source: String,
}

/// 続きの位置。直前のページの最後の行の `(z_order, id)`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AnnotationCursor {
    pub z_order: i32,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AnnotationPage {
    pub rows: Vec<AnnotationRow>,
    /// 続きがあるときだけ。
    pub next: Option<AnnotationCursor>,
}

pub(crate) fn row_of(row: &rusqlite::Row<'_>) -> rusqlite::Result<AnnotationRow> {
    Ok(AnnotationRow {
        id: row.get(0)?,
        annotation_type: row.get(1)?,
        type_version: u32::try_from(row.get::<_, i64>(2)?).unwrap_or(1),
        label_id: row.get(3)?,
        attributes_json: row.get(4)?,
        summary: row.get(5)?,
        z_order: row.get(6)?,
        source: row.get(7)?,
    })
}

pub(crate) const COLUMNS: &str =
    "id, type, type_version, label_id, attributes_json, summary, z_order, source";

/// アセット（`item_id` が `None`）、またはアイテムのアノテーションを、`(z_order, id)` 順に 1 ページ返す。
pub fn annotations_page(
    conn: &Connection,
    asset_id: &str,
    item_id: Option<&str>,
    cursor: Option<&AnnotationCursor>,
) -> Result<AnnotationPage, StoreError> {
    let (after_z, after_id) = cursor.map_or((i64::from(i32::MIN), ""), |c| {
        (i64::from(c.z_order), c.id.as_str())
    });
    let sql = format!(
        "SELECT {COLUMNS} FROM annotations \
         WHERE asset_id = ?1 AND item_id IS ?2 AND (z_order > ?3 OR (z_order = ?3 AND id > ?4)) \
         ORDER BY z_order, id LIMIT ?5"
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows: Vec<AnnotationRow> = stmt
        .query_map(
            rusqlite::params![asset_id, item_id, after_z, after_id, PAGE_SIZE + 1],
            row_of,
        )?
        .collect::<Result<_, _>>()?;
    let next = if rows.len() > PAGE_SIZE as usize {
        rows.truncate(PAGE_SIZE as usize);
        rows.last().map(|r| AnnotationCursor {
            z_order: r.z_order,
            id: r.id.clone(),
        })
    } else {
        None
    };
    Ok(AnnotationPage { rows, next })
}

/// `annotations_page` の、アイテムをキーで指定する版。行の無いアイテムは、空のページ。
pub fn annotations_page_for(
    conn: &Connection,
    asset_id: &str,
    item_key: Option<&str>,
    cursor: Option<&AnnotationCursor>,
) -> Result<AnnotationPage, StoreError> {
    let Some(key) = item_key else {
        return annotations_page(conn, asset_id, None, cursor);
    };
    let item_id: Option<String> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT id FROM items WHERE asset_id = ?1 AND item_key = ?2",
        [asset_id, key],
        |r| r.get(0),
    ))?;
    match item_id {
        Some(id) => annotations_page(conn, asset_id, Some(&id), cursor),
        None => Ok(AnnotationPage {
            rows: Vec::new(),
            next: None,
        }),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::migrations::PROJECT_V1;

    pub(crate) fn db_with_asset() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(PROJECT_V1).unwrap();
        conn.execute(
            "INSERT INTO assets (id, rel_path, file_size, mtime_ms, created_at, updated_at) \
             VALUES ('a1', 'a.bin', 0, 0, 0, 0), ('a2', 'b.bin', 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        conn
    }

    pub(crate) fn add(
        conn: &Connection,
        id: &str,
        asset: &str,
        item: Option<&str>,
        kind: &str,
        z: i32,
    ) {
        conn.execute(
            "INSERT INTO annotations (id, asset_id, item_id, type, selector_json, z_order, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, '{\"secret\":1}', ?5, 0, 0)",
            rusqlite::params![id, asset, item, kind, z],
        )
        .unwrap();
    }

    #[test]
    fn an_item_without_a_row_has_an_empty_page() {
        let conn = db_with_asset();
        add(&conn, "w", "a1", None, "t/t", 0);
        let page = annotations_page_for(&conn, "a1", Some("page:9"), None).unwrap();
        assert!(page.rows.is_empty() && page.next.is_none());
    }

    #[test]
    fn rows_do_not_carry_the_selector() {
        let conn = db_with_asset();
        add(&conn, "x", "a1", None, "com.example.shape/shape", 0);
        let page = annotations_page(&conn, "a1", None, None).unwrap();
        let json = serde_json::to_string(&page).unwrap();
        assert!(!json.contains("selector"));
        assert!(!json.contains("secret"));
        assert_eq!(page.rows.len(), 1);
        assert_eq!(page.rows[0].annotation_type, "com.example.shape/shape");
    }

    #[test]
    fn the_page_is_scoped_to_the_asset_and_the_item() {
        let conn = db_with_asset();
        conn.execute(
            "INSERT INTO items (id, asset_id, item_key, provider, created_at, updated_at) \
             VALUES ('i1', 'a1', 'page:1', 'p/x', 0, 0)",
            [],
        )
        .unwrap();
        add(&conn, "w", "a1", None, "core/classification", 0);
        add(&conn, "it", "a1", Some("i1"), "core/classification", 0);
        add(&conn, "o", "a2", None, "core/classification", 0);
        let ids = |item: Option<&str>, asset: &str| -> Vec<String> {
            annotations_page(&conn, asset, item, None)
                .unwrap()
                .rows
                .into_iter()
                .map(|r| r.id)
                .collect()
        };
        assert_eq!(ids(None, "a1"), ["w"]);
        assert_eq!(ids(Some("i1"), "a1"), ["it"]);
        assert_eq!(ids(None, "a2"), ["o"]);
    }

    #[test]
    fn pages_follow_the_cursor_without_gaps_or_repeats() {
        let conn = db_with_asset();
        let total = PAGE_SIZE as i32 * 2 + 5;
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..total {
            add(&tx, &format!("n{i:05}"), "a1", None, "t/t", i / 3);
        }
        tx.commit().unwrap();
        let mut seen = Vec::new();
        let mut cursor = None;
        let mut pages = 0;
        loop {
            let page = annotations_page(&conn, "a1", None, cursor.as_ref()).unwrap();
            pages += 1;
            seen.extend(page.rows.iter().map(|r| r.id.clone()));
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
        assert_eq!(pages, 3);
        assert_eq!(seen.len(), total as usize);
        let mut sorted = seen.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), total as usize);
        assert_eq!(seen, sorted);
    }
}
