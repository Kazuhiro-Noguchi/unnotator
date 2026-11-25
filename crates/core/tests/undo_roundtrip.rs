//! US3: すべてのコマンドについて、apply → undo → redo の往復で全テーブルの内容が一致する（憲章 VI）。
//! あわせて、履歴の性質（上限 500・Redo の破棄・transaction・対象外の操作）を確かめる。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use support::{create_label, new_project, read_conn, snapshot};
use unnotator_core::command::{
    AnnotationPatch, AttributeScope, COMMAND_NAMES, Command, Field, GroupPatch, ItemRef,
    LabelDisposition, LabelPatch, RelationPatch, Status, Target,
};
use unnotator_core::event::{ChangeKind, ChangeSet, Entity, Origin};
use unnotator_core::project::ProjectStore;

// ---- 準備に使う小さな部品（ID は呼び出し側で決める） ----

fn id(n: u32) -> String {
    format!("00000000-0000-7000-8000-{n:012x}")
}

fn annotation(n: u32, asset: &str) -> Command {
    Command::CreateAnnotation {
        id: Some(id(n)),
        target: Target {
            asset_id: asset.into(),
            item: None,
        },
        annotation_type: "com.example.shape/shape".into(),
        type_version: None,
        selector_json: "{ \"k\":  [1, 2] }".into(),
        label_id: None,
        attributes_json: None,
        summary: None,
        z_order: None,
        source: None,
    }
}

fn label(n: u32, name: &str) -> Command {
    let mut command = create_label(name);
    if let Command::CreateLabel { id: slot, .. } = &mut command {
        *slot = Some(id(n));
    }
    command
}

fn relation(n: u32, from: u32, to: u32) -> Command {
    Command::CreateRelation {
        id: Some(id(n)),
        relation_type: "com.example.rel/link".into(),
        from_id: id(from),
        to_id: id(to),
        directed: None,
        label_id: None,
        attributes_json: None,
        source: None,
    }
}

fn group(n: u32, members: &[u32]) -> Command {
    Command::CreateGroup {
        id: Some(id(n)),
        group_type: "com.example.grp/track".into(),
        ordered: Some(true),
        label_id: None,
        attributes_json: None,
        members: members.iter().map(|m| id(*m)).collect(),
        source: None,
    }
}

fn item() -> ItemRef {
    ItemRef {
        asset_id: "a1".into(),
        item_key: "page:1".into(),
        provider: "com.example.doc/pages".into(),
    }
}

fn schema(scope: AttributeScope, target: &str, title: &str) -> Command {
    Command::SetAttributeSchema {
        scope,
        target: target.into(),
        schema_json: format!(
            "{{\"type\":\"object\",\"properties\":{{\"c\":{{\"type\":\"string\",\"title\":\"{title}\"}}}}}}"
        ),
    }
}

/// ラベル 10・11 と、10 を使うアノテーション・関係・グループ・属性スキーマ。
fn labeled() -> Vec<Command> {
    vec![
        label(10, "person"),
        label(11, "human"),
        annotation(1, "a1"),
        annotation(2, "a1"),
        relation(20, 1, 2),
        group(30, &[1, 2]),
        Command::UpdateAnnotation {
            id: id(1),
            patch: AnnotationPatch {
                label_id: Field::Set(id(10)),
                ..AnnotationPatch::default()
            },
        },
        Command::UpdateRelation {
            id: id(20),
            patch: RelationPatch {
                label_id: Field::Set(id(10)),
                ..RelationPatch::default()
            },
        },
        Command::UpdateGroup {
            id: id(30),
            patch: GroupPatch {
                label_id: Field::Set(id(10)),
                ..GroupPatch::default()
            },
        },
        schema(AttributeScope::Label, &id(10), "label scoped"),
    ]
}

fn setup(store: &mut ProjectStore, commands: Vec<Command>) {
    for command in commands {
        store.apply_command(command).unwrap();
    }
}

/// 1 つの場面。準備をして、試すコマンドを返す。
struct Scenario {
    /// 試すコマンドの種類（`COMMAND_NAMES` のどれか）。
    command: &'static str,
    prepare: fn(&mut ProjectStore) -> Command,
}

fn scenarios() -> Vec<Scenario> {
    vec![
        Scenario {
            command: "create_annotation",
            prepare: |_| annotation(1, "a1"),
        },
        Scenario {
            command: "create_annotation",
            prepare: |_| Command::CreateAnnotation {
                id: Some(id(1)),
                target: Target {
                    asset_id: "a1".into(),
                    item: Some(item()),
                },
                annotation_type: "core/classification".into(),
                type_version: None,
                selector_json: "{}".into(),
                label_id: None,
                attributes_json: None,
                summary: None,
                z_order: None,
                source: None,
            },
        },
        Scenario {
            command: "update_annotation",
            prepare: |store| {
                setup(store, vec![label(10, "person"), annotation(1, "a1")]);
                Command::UpdateAnnotation {
                    id: id(1),
                    patch: AnnotationPatch {
                        label_id: Field::Set(id(10)),
                        summary: Field::Set("s".into()),
                        selector_json: Field::Set("{ \"z\": 0 }".into()),
                        z_order: Field::Set(7),
                        ..AnnotationPatch::default()
                    },
                }
            },
        },
        Scenario {
            command: "delete_annotation",
            prepare: |store| {
                setup(store, vec![annotation(1, "a1")]);
                Command::DeleteAnnotation { id: id(1) }
            },
        },
        Scenario {
            command: "delete_annotation",
            prepare: |store| {
                setup(
                    store,
                    vec![
                        annotation(1, "a1"),
                        annotation(2, "a2"),
                        annotation(3, "a1"),
                        relation(20, 1, 2),
                        relation(21, 3, 1),
                        group(30, &[3, 1, 2]),
                    ],
                );
                Command::DeleteAnnotation { id: id(1) }
            },
        },
        Scenario {
            command: "create_relation",
            prepare: |store| {
                setup(store, vec![annotation(1, "a1"), annotation(2, "a2")]);
                relation(20, 1, 2)
            },
        },
        Scenario {
            command: "update_relation",
            prepare: |store| {
                setup(
                    store,
                    vec![annotation(1, "a1"), annotation(2, "a1"), relation(20, 1, 2)],
                );
                Command::UpdateRelation {
                    id: id(20),
                    patch: RelationPatch {
                        directed: Field::Set(false),
                        attributes_json: Field::Set("{ \"w\": 1 }".into()),
                        ..RelationPatch::default()
                    },
                }
            },
        },
        Scenario {
            command: "delete_relation",
            prepare: |store| {
                setup(
                    store,
                    vec![annotation(1, "a1"), annotation(2, "a1"), relation(20, 1, 2)],
                );
                Command::DeleteRelation { id: id(20) }
            },
        },
        Scenario {
            command: "create_group",
            prepare: |store| {
                setup(store, vec![annotation(1, "a1"), annotation(2, "a1")]);
                group(30, &[2, 1])
            },
        },
        Scenario {
            command: "update_group",
            prepare: |store| {
                setup(store, vec![annotation(1, "a1"), group(30, &[1])]);
                Command::UpdateGroup {
                    id: id(30),
                    patch: GroupPatch {
                        ordered: Field::Set(false),
                        attributes_json: Field::Set("{ \"t\": 1 }".into()),
                        ..GroupPatch::default()
                    },
                }
            },
        },
        Scenario {
            command: "delete_group",
            prepare: |store| {
                setup(
                    store,
                    vec![annotation(1, "a1"), annotation(2, "a1"), group(30, &[1, 2])],
                );
                Command::DeleteGroup { id: id(30) }
            },
        },
        Scenario {
            command: "add_group_members",
            prepare: |store| {
                setup(
                    store,
                    vec![
                        annotation(1, "a1"),
                        annotation(2, "a1"),
                        annotation(3, "a1"),
                        group(30, &[1, 2]),
                    ],
                );
                Command::AddGroupMembers {
                    group_id: id(30),
                    annotation_ids: vec![id(3)],
                    at: Some(1),
                }
            },
        },
        Scenario {
            command: "remove_group_members",
            prepare: |store| {
                setup(
                    store,
                    vec![
                        annotation(1, "a1"),
                        annotation(2, "a1"),
                        annotation(3, "a1"),
                        group(30, &[1, 2, 3]),
                    ],
                );
                Command::RemoveGroupMembers {
                    group_id: id(30),
                    annotation_ids: vec![id(1)],
                }
            },
        },
        Scenario {
            command: "move_group_member",
            prepare: |store| {
                setup(
                    store,
                    vec![
                        annotation(1, "a1"),
                        annotation(2, "a1"),
                        annotation(3, "a1"),
                        group(30, &[1, 2, 3]),
                    ],
                );
                Command::MoveGroupMember {
                    group_id: id(30),
                    annotation_id: id(3),
                    to_position: 0,
                }
            },
        },
        Scenario {
            command: "create_label",
            prepare: |_| label(10, "person"),
        },
        Scenario {
            command: "update_label",
            prepare: |store| {
                setup(store, vec![label(10, "person")]);
                Command::UpdateLabel {
                    id: id(10),
                    patch: LabelPatch {
                        name: Field::Set("human".into()),
                        hotkey: Field::Set(2),
                        hidden: Field::Set(true),
                        ..LabelPatch::default()
                    },
                }
            },
        },
        Scenario {
            command: "delete_label",
            prepare: |store| {
                setup(store, labeled());
                Command::DeleteLabel {
                    id: id(10),
                    disposition: Some(LabelDisposition::Reassign {
                        to_label_id: id(11),
                    }),
                }
            },
        },
        Scenario {
            command: "delete_label",
            prepare: |store| {
                setup(store, labeled());
                Command::DeleteLabel {
                    id: id(10),
                    disposition: Some(LabelDisposition::Cascade),
                }
            },
        },
        Scenario {
            command: "delete_label",
            prepare: |store| {
                setup(store, vec![label(10, "person")]);
                Command::DeleteLabel {
                    id: id(10),
                    disposition: None,
                }
            },
        },
        Scenario {
            command: "set_attribute_schema",
            prepare: |_| schema(AttributeScope::Global, "", "one"),
        },
        Scenario {
            command: "set_attribute_schema",
            prepare: |store| {
                setup(store, vec![schema(AttributeScope::Global, "", "one")]);
                schema(AttributeScope::Global, "", "two")
            },
        },
        Scenario {
            command: "delete_attribute_schema",
            prepare: |store| {
                setup(store, vec![schema(AttributeScope::Global, "", "one")]);
                Command::DeleteAttributeSchema {
                    scope: AttributeScope::Global,
                    target: String::new(),
                }
            },
        },
        Scenario {
            command: "set_asset_status",
            prepare: |_| Command::SetAssetStatus {
                asset_id: "a1".into(),
                status: Status::Done,
            },
        },
        Scenario {
            command: "set_item_status",
            prepare: |_| Command::SetItemStatus {
                item: item(),
                status: Status::InProgress,
            },
        },
        Scenario {
            command: "set_item_status",
            prepare: |store| {
                setup(
                    store,
                    vec![Command::SetItemStatus {
                        item: item(),
                        status: Status::InProgress,
                    }],
                );
                Command::SetItemStatus {
                    item: item(),
                    status: Status::Review,
                }
            },
        },
        Scenario {
            command: "transaction",
            prepare: |_| Command::Transaction {
                commands: vec![
                    label(10, "person"),
                    annotation(1, "a1"),
                    annotation(2, "a2"),
                    relation(20, 1, 2),
                    group(30, &[1, 2]),
                    Command::SetAssetStatus {
                        asset_id: "a1".into(),
                        status: Status::Review,
                    },
                ],
            },
        },
    ]
}

/// 往復テストの網羅から外すコマンド。全コマンドが揃ったので空。
/// 往復の対象外のコマンド（Undo に積まない書き込み。振る舞いは `sync_command.rs` で確かめる）。
const PENDING: &[&str] = &["sync_assets"];

#[test]
fn every_command_round_trips() {
    for scenario in scenarios() {
        let (dir, mut store) = new_project(&["a1", "a2"]);
        let command = (scenario.prepare)(&mut store);
        assert_eq!(command.name(), scenario.command);

        let before = snapshot(&read_conn(dir.path()));
        let applied = store.apply_command(command).unwrap();
        let after = snapshot(&read_conn(dir.path()));
        assert_ne!(before, after, "{}: 何も変わっていない", scenario.command);

        let undone = store.undo().unwrap().expect("戻せる");
        assert_eq!(undone.origin, Origin::Undo, "{}", scenario.command);
        assert_eq!(
            snapshot(&read_conn(dir.path())),
            before,
            "{}: Undo で元に戻らない",
            scenario.command
        );

        let redone = store.redo().unwrap().expect("やり直せる");
        assert_eq!(redone.origin, Origin::Redo, "{}", scenario.command);
        assert_eq!(
            snapshot(&read_conn(dir.path())),
            after,
            "{}: Redo で適用直後に戻らない",
            scenario.command
        );

        // 差分は、適用・Undo・Redo で同じ対象を指し、種類が逆になる
        let ids = |set: &ChangeSet| -> BTreeSet<(String, String)> {
            set.changes
                .iter()
                .map(|c| (format!("{:?}", c.entity), c.id.clone()))
                .collect()
        };
        assert_eq!(ids(&applied), ids(&undone), "{}", scenario.command);
        assert_eq!(ids(&applied), ids(&redone), "{}", scenario.command);
        assert_eq!(
            applied.asset_ids.iter().collect::<BTreeSet<_>>(),
            undone.asset_ids.iter().collect::<BTreeSet<_>>()
        );
    }
}

#[test]
fn scenarios_cover_every_command() {
    let covered: BTreeSet<&str> = scenarios().iter().map(|s| s.command).collect();
    let all: BTreeSet<&str> = COMMAND_NAMES.iter().copied().collect();
    let pending: BTreeSet<&str> = PENDING.iter().copied().collect();
    let missing: Vec<_> = all
        .difference(&covered)
        .filter(|n| !pending.contains(*n))
        .collect();
    assert!(missing.is_empty(), "往復テストに無いコマンド: {missing:?}");
    let unknown: Vec<_> = covered.difference(&all).collect();
    assert!(unknown.is_empty(), "存在しないコマンド: {unknown:?}");
}

#[test]
fn undo_inverts_the_kinds_and_redo_restores_them() {
    let (_dir, mut store) = new_project(&["a1"]);
    let applied = store.apply_command(annotation(1, "a1")).unwrap();
    assert_eq!(applied.changes[0].kind, ChangeKind::Created);
    let undone = store.undo().unwrap().unwrap();
    assert_eq!(undone.changes[0].kind, ChangeKind::Deleted);
    assert_eq!(undone.changes[0].entity, Entity::Annotation);
    let redone = store.redo().unwrap().unwrap();
    assert_eq!(redone.changes[0].kind, ChangeKind::Created);
    assert!(undone.seq > applied.seq && redone.seq > undone.seq);
}

// ---- 履歴の性質（FR-021〜FR-026） ----

#[test]
fn nothing_to_undo_or_redo_returns_none() {
    let (_dir, mut store) = new_project(&[]);
    assert!(store.undo().unwrap().is_none());
    assert!(store.redo().unwrap().is_none());
    let state = store.undo_state();
    assert!(!state.can_undo && !state.can_redo);
}

#[test]
fn a_new_command_after_undo_discards_redo() {
    let (_dir, mut store) = new_project(&["a1"]);
    store.apply_command(annotation(1, "a1")).unwrap();
    store.undo().unwrap();
    assert!(store.undo_state().can_redo);
    store.apply_command(annotation(2, "a1")).unwrap();
    assert!(!store.undo_state().can_redo);
    assert!(store.redo().unwrap().is_none());
}

#[test]
fn history_keeps_the_latest_500_operations() {
    let (dir, mut store) = new_project(&[]);
    for n in 0..501 {
        store
            .apply_command(create_label(&format!("label-{n}")))
            .unwrap();
    }
    assert_eq!(store.undo_state().undo_depth, 500);
    for _ in 0..500 {
        assert!(store.undo().unwrap().is_some());
    }
    // 最古の 1 個だけは戻せない
    assert!(store.undo().unwrap().is_none());
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 1);
    for _ in 0..500 {
        assert!(store.redo().unwrap().is_some());
    }
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 501);
}

#[test]
fn a_transaction_is_one_undo_step() {
    let (dir, mut store) = new_project(&["a1"]);
    let before = snapshot(&read_conn(dir.path()));
    store
        .apply_command(Command::Transaction {
            commands: vec![label(10, "a"), label(11, "b"), annotation(1, "a1")],
        })
        .unwrap();
    assert_eq!(store.undo_state().undo_depth, 1);
    store.undo().unwrap().unwrap();
    assert_eq!(snapshot(&read_conn(dir.path())), before);
    assert!(!store.undo_state().can_undo);
}

#[test]
fn failed_commands_leave_no_history() {
    let (_dir, mut store) = new_project(&["a1"]);
    assert!(store.apply_command(annotation(1, "missing")).is_err());
    assert!(!store.undo_state().can_undo);
}

#[test]
fn operations_outside_the_command_path_are_not_in_the_history() {
    let (dir, mut store) = new_project(&["a1"]);
    store.apply_command(annotation(1, "a1")).unwrap();
    // アセットの追加と拡張機能専用のデータは、Undo の対象外（コアのコマンドを通らない）
    {
        let conn = Connection::open(support::working_db_path(dir.path())).unwrap();
        support::insert_asset(&conn, "a9", "later.bin");
        conn.execute(
            "INSERT INTO plugin_data (plugin_id, scope, scope_id, key, value_json, updated_at) \
             VALUES ('com.example.x', 'project', '', 'k', '1', 0)",
            [],
        )
        .unwrap();
    }
    assert_eq!(store.undo_state().undo_depth, 1);
    store.undo().unwrap().unwrap();
    let conn = read_conn(dir.path());
    assert_eq!(support::count(&conn, "annotations"), 0);
    assert_eq!(support::count(&conn, "plugin_data"), 1);
    assert!(support::row(&conn, "assets", "a9").is_some());
}

#[test]
fn subscribers_hear_about_undo_and_redo() {
    let (_dir, mut store) = new_project(&["a1"]);
    let seen: Arc<Mutex<Vec<Origin>>> = Arc::default();
    let sink = Arc::clone(&seen);
    store.subscribe(Box::new(move |set| sink.lock().unwrap().push(set.origin)));
    store.apply_command(annotation(1, "a1")).unwrap();
    store.undo().unwrap();
    store.redo().unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        vec![Origin::Apply, Origin::Undo, Origin::Redo]
    );
}
