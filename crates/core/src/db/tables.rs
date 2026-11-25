//! Undo の対象になるテーブルの定義（列と主キー）。列の並びは契約の SQL（版 1）に合わせる。
//! `meta` と `plugin_data` は含めない（`meta` は Undo の対象外、`plugin_data` は触らない）。

#[derive(Debug)]
pub struct TableDef {
    pub name: &'static str,
    pub columns: &'static [&'static str],
    pub pk: &'static [&'static str],
}

impl TableDef {
    /// 列の位置（見つからなければ `None`）。
    pub fn column_index(&self, column: &str) -> Option<usize> {
        self.columns.iter().position(|c| *c == column)
    }

    /// 主キーの列の位置（主キーの順）。
    pub fn pk_indexes(&self) -> Vec<usize> {
        self.pk
            .iter()
            .filter_map(|c| self.column_index(c))
            .collect()
    }
}

pub const ASSETS: TableDef = TableDef {
    name: "assets",
    columns: &[
        "id",
        "root_key",
        "rel_path",
        "media_type",
        "file_size",
        "mtime_ms",
        "status",
        "missing",
        "metadata_json",
        "attributes_json",
        "note",
        "created_at",
        "updated_at",
    ],
    pk: &["id"],
};

pub const ITEMS: TableDef = TableDef {
    name: "items",
    columns: &[
        "id",
        "asset_id",
        "item_key",
        "provider",
        "status",
        "metadata_json",
        "attributes_json",
        "created_at",
        "updated_at",
    ],
    pk: &["id"],
};

pub const LABELS: TableDef = TableDef {
    name: "labels",
    columns: &[
        "id",
        "name",
        "name_i18n_json",
        "color",
        "hotkey",
        "sort_order",
        "hidden",
        "applies_to_json",
        "created_at",
        "updated_at",
    ],
    pk: &["id"],
};

pub const ATTRIBUTE_SCHEMAS: TableDef = TableDef {
    name: "attribute_schemas",
    columns: &["id", "scope", "target", "schema_json", "updated_at"],
    pk: &["id"],
};

pub const ANNOTATIONS: TableDef = TableDef {
    name: "annotations",
    columns: &[
        "id",
        "asset_id",
        "item_id",
        "type",
        "type_version",
        "selector_json",
        "label_id",
        "attributes_json",
        "summary",
        "z_order",
        "source",
        "created_at",
        "updated_at",
    ],
    pk: &["id"],
};

pub const RELATIONS: TableDef = TableDef {
    name: "relations",
    columns: &[
        "id",
        "type",
        "from_id",
        "to_id",
        "directed",
        "label_id",
        "attributes_json",
        "source",
        "created_at",
        "updated_at",
    ],
    pk: &["id"],
};

pub const ANNOTATION_GROUPS: TableDef = TableDef {
    name: "annotation_groups",
    columns: &[
        "id",
        "type",
        "ordered",
        "label_id",
        "attributes_json",
        "source",
        "created_at",
        "updated_at",
    ],
    pk: &["id"],
};

pub const GROUP_MEMBERS: TableDef = TableDef {
    name: "group_members",
    columns: &["group_id", "annotation_id", "position"],
    pk: &["group_id", "annotation_id"],
};

pub const TABLES: &[&TableDef] = &[
    &ASSETS,
    &ITEMS,
    &LABELS,
    &ATTRIBUTE_SCHEMAS,
    &ANNOTATIONS,
    &RELATIONS,
    &ANNOTATION_GROUPS,
    &GROUP_MEMBERS,
];

/// 名前からテーブルの定義を引く。
pub fn table(name: &str) -> Option<&'static TableDef> {
    TABLES.iter().copied().find(|t| t.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::PROJECT_V1;
    use rusqlite::Connection;

    /// 定義が契約の SQL（実際のテーブル）と食い違っていないこと。
    #[test]
    fn definitions_match_the_contract_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(PROJECT_V1).unwrap();
        for def in TABLES {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({})", def.name))
                .unwrap();
            let actual: Vec<(String, i64)> = stmt
                .query_map([], |row| Ok((row.get(1)?, row.get(5)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let names: Vec<&str> = actual.iter().map(|(n, _)| n.as_str()).collect();
            assert_eq!(names, def.columns, "{} の列", def.name);
            let mut pk: Vec<(i64, &str)> = actual
                .iter()
                .filter(|(_, p)| *p > 0)
                .map(|(n, p)| (*p, n.as_str()))
                .collect();
            pk.sort();
            let pk_names: Vec<&str> = pk.into_iter().map(|(_, n)| n).collect();
            assert_eq!(pk_names, def.pk, "{} の主キー", def.name);
        }
    }

    #[test]
    fn lookup_by_name() {
        assert!(table("annotations").is_some());
        assert!(table("plugin_data").is_none());
        assert!(table("meta").is_none());
    }
}
