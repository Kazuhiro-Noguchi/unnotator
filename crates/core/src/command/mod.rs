//! コマンドの型（contracts/commands.md）。プロジェクトデータの変更はすべてこれを `apply_command` に渡して行う。
//!
//! 媒体に関係しない（憲章 I）。`*_json` は JSON テキストで、コアは中身を解釈しない（research.md R3）。

use serde::{Deserialize, Serialize};

/// 項目ごとの「変えない / 値にする / 空にする」。更新のパッチで使う。
/// `Clear` は空にできる（NULL を許す）項目にだけ使える。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Field<T> {
    #[default]
    Keep,
    Set(T),
    Clear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Status {
    Todo,
    InProgress,
    Done,
    Review,
}

impl Status {
    /// 契約の CHECK の値。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Review => "review",
        }
    }
}

/// アイテム（アセットの分割単位）。行が無ければ、必要なコマンドが作る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ItemRef {
    pub asset_id: String,
    pub item_key: String,
    pub provider: String,
}

/// アノテーションの対象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Target {
    pub asset_id: String,
    #[serde(default)]
    pub item: Option<ItemRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum AttributeScope {
    Global,
    Label,
    AnnotationType,
    RelationType,
    GroupType,
    Asset,
    Item,
}

impl AttributeScope {
    /// 契約の CHECK の値。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Label => "label",
            Self::AnnotationType => "annotation_type",
            Self::RelationType => "relation_type",
            Self::GroupType => "group_type",
            Self::Asset => "asset",
            Self::Item => "item",
        }
    }
}

/// 使用中のラベルを削除するときの扱い。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum LabelDisposition {
    /// 使っているものの `label_id` を別のラベルへ付け替える。
    Reassign { to_label_id: String },
    /// 使っているものごと削除する。
    Cascade,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct AnnotationPatch {
    pub type_version: Field<u32>,
    pub selector_json: Field<String>,
    pub label_id: Field<String>,
    pub attributes_json: Field<String>,
    pub summary: Field<String>,
    pub z_order: Field<i32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct RelationPatch {
    pub directed: Field<bool>,
    pub label_id: Field<String>,
    pub attributes_json: Field<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct GroupPatch {
    pub ordered: Field<bool>,
    pub label_id: Field<String>,
    pub attributes_json: Field<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct LabelPatch {
    pub name: Field<String>,
    pub name_i18n_json: Field<String>,
    pub color: Field<String>,
    pub hotkey: Field<u8>,
    pub sort_order: Field<i32>,
    pub hidden: Field<bool>,
    pub applies_to_json: Field<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Command {
    CreateAnnotation {
        target: Target,
        #[serde(rename = "type")]
        annotation_type: String,
        #[serde(default)]
        type_version: Option<u32>,
        selector_json: String,
        #[serde(default)]
        label_id: Option<String>,
        #[serde(default)]
        attributes_json: Option<String>,
        #[serde(default)]
        summary: Option<String>,
        #[serde(default)]
        z_order: Option<i32>,
        #[serde(default)]
        source: Option<String>,
    },
    UpdateAnnotation {
        id: String,
        patch: AnnotationPatch,
    },
    DeleteAnnotation {
        id: String,
    },
    CreateRelation {
        #[serde(rename = "type")]
        relation_type: String,
        from_id: String,
        to_id: String,
        #[serde(default)]
        directed: Option<bool>,
        #[serde(default)]
        label_id: Option<String>,
        #[serde(default)]
        attributes_json: Option<String>,
        #[serde(default)]
        source: Option<String>,
    },
    UpdateRelation {
        id: String,
        patch: RelationPatch,
    },
    DeleteRelation {
        id: String,
    },
    CreateGroup {
        #[serde(rename = "type")]
        group_type: String,
        #[serde(default)]
        ordered: Option<bool>,
        #[serde(default)]
        label_id: Option<String>,
        #[serde(default)]
        attributes_json: Option<String>,
        #[serde(default)]
        members: Vec<String>,
        #[serde(default)]
        source: Option<String>,
    },
    UpdateGroup {
        id: String,
        patch: GroupPatch,
    },
    DeleteGroup {
        id: String,
    },
    AddGroupMembers {
        group_id: String,
        annotation_ids: Vec<String>,
        #[serde(default)]
        at: Option<u32>,
    },
    RemoveGroupMembers {
        group_id: String,
        annotation_ids: Vec<String>,
    },
    MoveGroupMember {
        group_id: String,
        annotation_id: String,
        to_position: u32,
    },
    CreateLabel {
        name: String,
        #[serde(default)]
        name_i18n_json: Option<String>,
        color: String,
        #[serde(default)]
        hotkey: Option<u8>,
        #[serde(default)]
        sort_order: Option<i32>,
        #[serde(default)]
        hidden: Option<bool>,
        #[serde(default)]
        applies_to_json: Option<String>,
    },
    UpdateLabel {
        id: String,
        patch: LabelPatch,
    },
    DeleteLabel {
        id: String,
        #[serde(default)]
        disposition: Option<LabelDisposition>,
    },
    SetAttributeSchema {
        scope: AttributeScope,
        target: String,
        schema_json: String,
    },
    DeleteAttributeSchema {
        scope: AttributeScope,
        target: String,
    },
    SetAssetStatus {
        asset_id: String,
        status: Status,
    },
    SetItemStatus {
        item: ItemRef,
        status: Status,
    },
    /// 全体を 1 つの適用・1 つの Undo 単位にする。入れ子にはできない。
    Transaction {
        commands: Vec<Command>,
    },
}

/// 全コマンドの名前（往復テストの網羅の突き合わせに使う）。
pub const COMMAND_NAMES: &[&str] = &[
    "create_annotation",
    "update_annotation",
    "delete_annotation",
    "create_relation",
    "update_relation",
    "delete_relation",
    "create_group",
    "update_group",
    "delete_group",
    "add_group_members",
    "remove_group_members",
    "move_group_member",
    "create_label",
    "update_label",
    "delete_label",
    "set_attribute_schema",
    "delete_attribute_schema",
    "set_asset_status",
    "set_item_status",
    "transaction",
];

impl Command {
    /// `kind` に使う名前。`COMMAND_NAMES` のどれかと一致する。
    pub fn name(&self) -> &'static str {
        match self {
            Self::CreateAnnotation { .. } => "create_annotation",
            Self::UpdateAnnotation { .. } => "update_annotation",
            Self::DeleteAnnotation { .. } => "delete_annotation",
            Self::CreateRelation { .. } => "create_relation",
            Self::UpdateRelation { .. } => "update_relation",
            Self::DeleteRelation { .. } => "delete_relation",
            Self::CreateGroup { .. } => "create_group",
            Self::UpdateGroup { .. } => "update_group",
            Self::DeleteGroup { .. } => "delete_group",
            Self::AddGroupMembers { .. } => "add_group_members",
            Self::RemoveGroupMembers { .. } => "remove_group_members",
            Self::MoveGroupMember { .. } => "move_group_member",
            Self::CreateLabel { .. } => "create_label",
            Self::UpdateLabel { .. } => "update_label",
            Self::DeleteLabel { .. } => "delete_label",
            Self::SetAttributeSchema { .. } => "set_attribute_schema",
            Self::DeleteAttributeSchema { .. } => "delete_attribute_schema",
            Self::SetAssetStatus { .. } => "set_asset_status",
            Self::SetItemStatus { .. } => "set_item_status",
            Self::Transaction { .. } => "transaction",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Command {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn commands_deserialize_from_tagged_json() {
        let command = parse(r#"{"kind":"delete_annotation","id":"x"}"#);
        assert_eq!(command, Command::DeleteAnnotation { id: "x".into() });
        assert_eq!(command.name(), "delete_annotation");
    }

    #[test]
    fn create_annotation_keeps_selector_text_exactly() {
        // 空白・キー順を含む文字列が、そのまま保たれる（解釈しない）。
        let selector = "{ \"b\": 1,\n \"a\": [1, 2] }";
        let json = serde_json::json!({
            "kind": "create_annotation",
            "target": {"asset_id": "a1"},
            "type": "com.example/shape",
            "selector_json": selector,
        });
        let Command::CreateAnnotation {
            selector_json,
            annotation_type,
            target,
            ..
        } = serde_json::from_value(json).unwrap()
        else {
            panic!("create_annotation ではない");
        };
        assert_eq!(selector_json, selector);
        assert_eq!(annotation_type, "com.example/shape");
        assert_eq!(target.item, None);
    }

    #[test]
    fn patch_fields_default_to_keep_and_can_clear() {
        let command = parse(
            r#"{"kind":"update_annotation","id":"n1","patch":{"label_id":{"kind":"clear"},"summary":{"kind":"set","value":"s"}}}"#,
        );
        let Command::UpdateAnnotation { patch, .. } = command else {
            panic!("update_annotation ではない");
        };
        assert_eq!(patch.label_id, Field::Clear);
        assert_eq!(patch.summary, Field::Set("s".into()));
        assert_eq!(patch.selector_json, Field::Keep);
    }

    #[test]
    fn label_disposition_is_tagged() {
        let command = parse(
            r#"{"kind":"delete_label","id":"l1","disposition":{"kind":"reassign","to_label_id":"l2"}}"#,
        );
        assert_eq!(
            command,
            Command::DeleteLabel {
                id: "l1".into(),
                disposition: Some(LabelDisposition::Reassign {
                    to_label_id: "l2".into()
                })
            }
        );
    }

    #[test]
    fn command_names_list_matches_every_variant() {
        // 各バリアントを 1 つずつ作り、名前が一覧にあること、一覧に重複が無いことを確かめる。
        let patch_label = LabelPatch::default();
        let item = ItemRef {
            asset_id: "a".into(),
            item_key: "k".into(),
            provider: "p/q".into(),
        };
        let samples = vec![
            Command::CreateAnnotation {
                target: Target {
                    asset_id: "a".into(),
                    item: None,
                },
                annotation_type: "x/y".into(),
                type_version: None,
                selector_json: "{}".into(),
                label_id: None,
                attributes_json: None,
                summary: None,
                z_order: None,
                source: None,
            },
            Command::UpdateAnnotation {
                id: "n".into(),
                patch: AnnotationPatch::default(),
            },
            Command::DeleteAnnotation { id: "n".into() },
            Command::CreateRelation {
                relation_type: "x/y".into(),
                from_id: "a".into(),
                to_id: "b".into(),
                directed: None,
                label_id: None,
                attributes_json: None,
                source: None,
            },
            Command::UpdateRelation {
                id: "r".into(),
                patch: RelationPatch::default(),
            },
            Command::DeleteRelation { id: "r".into() },
            Command::CreateGroup {
                group_type: "x/y".into(),
                ordered: None,
                label_id: None,
                attributes_json: None,
                members: vec![],
                source: None,
            },
            Command::UpdateGroup {
                id: "g".into(),
                patch: GroupPatch::default(),
            },
            Command::DeleteGroup { id: "g".into() },
            Command::AddGroupMembers {
                group_id: "g".into(),
                annotation_ids: vec![],
                at: None,
            },
            Command::RemoveGroupMembers {
                group_id: "g".into(),
                annotation_ids: vec![],
            },
            Command::MoveGroupMember {
                group_id: "g".into(),
                annotation_id: "n".into(),
                to_position: 0,
            },
            Command::CreateLabel {
                name: "n".into(),
                name_i18n_json: None,
                color: "#000000".into(),
                hotkey: None,
                sort_order: None,
                hidden: None,
                applies_to_json: None,
            },
            Command::UpdateLabel {
                id: "l".into(),
                patch: patch_label,
            },
            Command::DeleteLabel {
                id: "l".into(),
                disposition: None,
            },
            Command::SetAttributeSchema {
                scope: AttributeScope::Global,
                target: String::new(),
                schema_json: "{}".into(),
            },
            Command::DeleteAttributeSchema {
                scope: AttributeScope::Global,
                target: String::new(),
            },
            Command::SetAssetStatus {
                asset_id: "a".into(),
                status: Status::Done,
            },
            Command::SetItemStatus {
                item,
                status: Status::Review,
            },
            Command::Transaction { commands: vec![] },
        ];
        let names: Vec<&str> = samples.iter().map(Command::name).collect();
        assert_eq!(names, COMMAND_NAMES);
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), COMMAND_NAMES.len());
        // serde の `kind` が `name()` と一致する
        for command in &samples {
            let value = serde_json::to_value(command).unwrap();
            assert_eq!(value["kind"], command.name());
        }
    }
}
