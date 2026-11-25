//! 差分（`ChangeSet`）と、購読・確定前の差し込み口。
//!
//! 差分は行の変更（`RowOp`）から機械的に作る。購読者へはコミットの後に通知する。

use std::collections::HashMap;

use rusqlite::Connection;
use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

use crate::db::tables::{ANNOTATIONS, GROUP_MEMBERS, ITEMS, RELATIONS};
use crate::error::StoreError;
use crate::history::recorder::RowOp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Origin {
    Apply,
    Undo,
    Redo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Entity {
    Annotation,
    Relation,
    Group,
    GroupMember,
    Label,
    AttributeSchema,
    Asset,
    Item,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum ChangeKind {
    Created,
    Updated,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct Change {
    pub entity: Entity,
    /// 主キー。複合主キー（グループの所属）は `/` でつなぐ。
    pub id: String,
    pub kind: ChangeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct ChangeSet {
    pub seq: u32,
    pub origin: Origin,
    pub changes: Vec<Change>,
    /// この変更が属するアセット（重複なし）。
    pub asset_ids: Vec<String>,
}

fn entity_of(table: &str) -> Option<Entity> {
    Some(match table {
        "annotations" => Entity::Annotation,
        "relations" => Entity::Relation,
        "annotation_groups" => Entity::Group,
        "group_members" => Entity::GroupMember,
        "labels" => Entity::Label,
        "attribute_schemas" => Entity::AttributeSchema,
        "assets" => Entity::Asset,
        "items" => Entity::Item,
        _ => return None,
    })
}

fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::Text(s) => Some(s.clone()),
        Value::Integer(i) => Some(i.to_string()),
        _ => None,
    }
}

impl ChangeSet {
    /// `ops` から差分を作る。`origin` が `Undo` のときは、変更を逆順にたどり、作成と削除を入れ替える。
    /// `lookup` は、同じ変更に含まれないアノテーションの所属アセットを DB から引く。
    pub fn from_ops(
        seq: u32,
        origin: Origin,
        ops: &[RowOp],
        lookup: &dyn Fn(&str) -> Option<String>,
    ) -> Self {
        // 同じ変更に含まれるアノテーションの所属アセット（削除されていても引けるように、行のイメージから取る）
        let mut annotation_assets: HashMap<String, String> = HashMap::new();
        let asset_col = ANNOTATIONS.column_index("asset_id").unwrap_or(1);
        for op in ops.iter().filter(|op| op.table == "annotations") {
            let row = op.after.as_ref().or(op.before.as_ref());
            if let (Some(row), Some(id)) = (row, op.key.first().and_then(value_text))
                && let Some(asset) = row.get(asset_col).and_then(value_text)
            {
                annotation_assets.insert(id, asset);
            }
        }
        let asset_of_annotation = |id: &str| -> Option<String> {
            annotation_assets.get(id).cloned().or_else(|| lookup(id))
        };

        let ordered: Vec<&RowOp> = if origin == Origin::Undo {
            ops.iter().rev().collect()
        } else {
            ops.iter().collect()
        };

        let mut changes = Vec::new();
        let mut asset_ids: Vec<String> = Vec::new();
        let mut add_asset = |asset: Option<String>| {
            if let Some(asset) = asset
                && !asset_ids.contains(&asset)
            {
                asset_ids.push(asset);
            }
        };

        for op in ordered {
            let Some(entity) = entity_of(op.table) else {
                continue;
            };
            let (before, after) = if origin == Origin::Undo {
                (&op.after, &op.before)
            } else {
                (&op.before, &op.after)
            };
            let kind = match (before, after) {
                (None, Some(_)) => ChangeKind::Created,
                (Some(_), None) => ChangeKind::Deleted,
                _ => ChangeKind::Updated,
            };
            let id = op
                .key
                .iter()
                .filter_map(value_text)
                .collect::<Vec<_>>()
                .join("/");
            changes.push(Change { entity, id, kind });

            let row = op.after.as_ref().or(op.before.as_ref());
            let Some(row) = row else { continue };
            match entity {
                Entity::Asset => add_asset(op.key.first().and_then(value_text)),
                Entity::Item => add_asset(
                    ITEMS
                        .column_index("asset_id")
                        .and_then(|i| row.get(i))
                        .and_then(value_text),
                ),
                Entity::Annotation => add_asset(row.get(asset_col).and_then(value_text)),
                Entity::Relation => {
                    for column in ["from_id", "to_id"] {
                        let annotation = RELATIONS
                            .column_index(column)
                            .and_then(|i| row.get(i))
                            .and_then(value_text);
                        if let Some(annotation) = annotation {
                            add_asset(asset_of_annotation(&annotation));
                        }
                    }
                }
                Entity::GroupMember => {
                    let annotation = GROUP_MEMBERS
                        .column_index("annotation_id")
                        .and_then(|i| row.get(i))
                        .and_then(value_text);
                    if let Some(annotation) = annotation {
                        add_asset(asset_of_annotation(&annotation));
                    }
                }
                Entity::Group | Entity::Label | Entity::AttributeSchema => {}
            }
        }

        Self {
            seq,
            origin,
            changes,
            asset_ids,
        }
    }
}

/// コミットの直前に、変更の行イメージを受け取る差し込み口。
/// 003 が journal を同じトランザクション内で書くために使う。失敗すると適用全体が取り消される。
pub trait ChangeObserver: Send {
    fn before_commit(&mut self, conn: &Connection, ops: &[RowOp]) -> Result<(), StoreError> {
        let _ = (conn, ops);
        Ok(())
    }
}

type Subscriber = Box<dyn Fn(&ChangeSet) + Send>;

/// 購読者と `ChangeObserver` を束ねる。
#[derive(Default)]
pub struct EventHub {
    subscribers: Vec<Subscriber>,
    observers: Vec<Box<dyn ChangeObserver>>,
}

impl EventHub {
    pub fn subscribe(&mut self, subscriber: Subscriber) {
        self.subscribers.push(subscriber);
    }

    pub fn add_observer(&mut self, observer: Box<dyn ChangeObserver>) {
        self.observers.push(observer);
    }

    pub fn run_before_commit(
        &mut self,
        conn: &Connection,
        ops: &[RowOp],
    ) -> Result<(), StoreError> {
        for observer in &mut self.observers {
            observer.before_commit(conn, ops)?;
        }
        Ok(())
    }

    /// コミットのあとに、すべての購読者へ 1 回ずつ通知する。
    pub fn notify(&self, set: &ChangeSet) {
        for subscriber in &self.subscribers {
            subscriber(set);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::recorder::RowOp;
    use rusqlite::Connection;
    use rusqlite::types::Value;
    use std::sync::{Arc, Mutex};

    fn text(s: &str) -> Value {
        Value::Text(s.to_owned())
    }

    /// annotations の行（asset_id だけが意味を持つ）。
    fn annotation_row(id: &str, asset_id: &str) -> Vec<Value> {
        let mut row = vec![Value::Null; crate::db::tables::ANNOTATIONS.columns.len()];
        row[0] = text(id);
        row[1] = text(asset_id);
        row
    }

    fn relation_row(id: &str, from: &str, to: &str) -> Vec<Value> {
        let mut row = vec![Value::Null; crate::db::tables::RELATIONS.columns.len()];
        row[0] = text(id);
        row[2] = text(from);
        row[3] = text(to);
        row
    }

    fn no_lookup(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn change_kinds_follow_before_and_after() {
        let ops = vec![
            RowOp {
                table: "annotations",
                key: vec![text("n1")],
                before: None,
                after: Some(annotation_row("n1", "a1")),
            },
            RowOp {
                table: "annotations",
                key: vec![text("n2")],
                before: Some(annotation_row("n2", "a1")),
                after: Some(annotation_row("n2", "a1")),
            },
            RowOp {
                table: "annotations",
                key: vec![text("n3")],
                before: Some(annotation_row("n3", "a2")),
                after: None,
            },
        ];
        let set = ChangeSet::from_ops(7, Origin::Apply, &ops, &no_lookup);
        assert_eq!(set.seq, 7);
        let kinds: Vec<_> = set
            .changes
            .iter()
            .map(|c| (c.id.as_str(), c.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("n1", ChangeKind::Created),
                ("n2", ChangeKind::Updated),
                ("n3", ChangeKind::Deleted)
            ]
        );
        assert_eq!(set.asset_ids, vec!["a1".to_owned(), "a2".to_owned()]);
    }

    #[test]
    fn undo_origin_inverts_kinds_and_reverses_order() {
        let ops = vec![
            RowOp {
                table: "annotations",
                key: vec![text("n1")],
                before: None,
                after: Some(annotation_row("n1", "a1")),
            },
            RowOp {
                table: "annotations",
                key: vec![text("n2")],
                before: None,
                after: Some(annotation_row("n2", "a1")),
            },
        ];
        let set = ChangeSet::from_ops(8, Origin::Undo, &ops, &no_lookup);
        let kinds: Vec<_> = set
            .changes
            .iter()
            .map(|c| (c.id.as_str(), c.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![("n2", ChangeKind::Deleted), ("n1", ChangeKind::Deleted)]
        );
    }

    #[test]
    fn relation_includes_assets_of_both_ends_even_when_annotations_are_deleted() {
        let ops = vec![
            RowOp {
                table: "relations",
                key: vec![text("r1")],
                before: Some(relation_row("r1", "n1", "n2")),
                after: None,
            },
            RowOp {
                table: "annotations",
                key: vec![text("n1")],
                before: Some(annotation_row("n1", "a1")),
                after: None,
            },
        ];
        // n2 は同じ変更に含まれないので、DB（lookup）から引く
        let lookup = |id: &str| (id == "n2").then(|| "a9".to_owned());
        let set = ChangeSet::from_ops(1, Origin::Apply, &ops, &lookup);
        assert_eq!(set.asset_ids, vec!["a1".to_owned(), "a9".to_owned()]);
    }

    #[test]
    fn labels_and_attribute_schemas_have_no_assets() {
        let ops = vec![RowOp {
            table: "labels",
            key: vec![text("l1")],
            before: None,
            after: Some(vec![text("l1")]),
        }];
        let set = ChangeSet::from_ops(1, Origin::Apply, &ops, &no_lookup);
        assert_eq!(set.changes[0].entity, Entity::Label);
        assert!(set.asset_ids.is_empty());
    }

    #[test]
    fn subscribers_are_notified_once_each() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let mut hub = EventHub::default();
        for _ in 0..2 {
            let sink = Arc::clone(&received);
            hub.subscribe(Box::new(move |set: &ChangeSet| {
                sink.lock().unwrap().push(set.seq);
            }));
        }
        let set = ChangeSet::from_ops(5, Origin::Apply, &[], &no_lookup);
        hub.notify(&set);
        assert_eq!(*received.lock().unwrap(), vec![5, 5]);
    }

    struct Failing;
    impl ChangeObserver for Failing {
        fn before_commit(
            &mut self,
            _conn: &Connection,
            _ops: &[RowOp],
        ) -> Result<(), crate::error::StoreError> {
            Err(crate::error::StoreError::InvalidCommand("journal".into()))
        }
    }

    #[test]
    fn failing_observer_aborts_before_commit() {
        let conn = Connection::open_in_memory().unwrap();
        let mut hub = EventHub::default();
        hub.add_observer(Box::new(Failing));
        assert!(hub.run_before_commit(&conn, &[]).is_err());
        let mut empty = EventHub::default();
        assert!(empty.run_before_commit(&conn, &[]).is_ok());
    }
}
