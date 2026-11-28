//! 009: 拡張機能専用の保存領域（`host.storage`。`plugin_data`）。Undo に積まないが、未保存に数え、保存で残る。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{create_and_open, new_project, open_store, read_saved_conn, save_and_close};
use unnotator_core::command::{Command, PluginScope};
use unnotator_core::error::StoreError;

fn set(plugin: &str, scope: PluginScope, scope_id: &str, key: &str, value: &str) -> Command {
    Command::SetPluginData {
        plugin_id: plugin.into(),
        scope,
        scope_id: scope_id.into(),
        key: key.into(),
        value_json: value.into(),
    }
}

#[test]
fn values_are_separated_by_plugin_scope_and_key() {
    let (_dir, mut store) = new_project(&["a1"]);
    store
        .apply_command(set("com.a", PluginScope::Project, "", "k", "1"))
        .unwrap();
    store
        .apply_command(set("com.b", PluginScope::Project, "", "k", "2"))
        .unwrap();
    store
        .apply_command(set("com.a", PluginScope::Asset, "a1", "k", "3"))
        .unwrap();
    store
        .apply_command(set("com.a", PluginScope::Item, "a1/page:3", "k", "4"))
        .unwrap();
    let value = |store: &unnotator_core::project::ProjectStore,
                 plugin: &str,
                 scope: PluginScope,
                 id: &str| store.plugin_value(plugin, scope, id, "k").unwrap();
    assert_eq!(
        value(&store, "com.a", PluginScope::Project, ""),
        Some("1".into())
    );
    assert_eq!(
        value(&store, "com.b", PluginScope::Project, ""),
        Some("2".into())
    );
    assert_eq!(
        value(&store, "com.a", PluginScope::Asset, "a1"),
        Some("3".into())
    );
    assert_eq!(
        value(&store, "com.a", PluginScope::Item, "a1/page:3"),
        Some("4".into())
    );
    assert_eq!(value(&store, "com.a", PluginScope::Asset, "zz"), None);
    // 同じキーは置き換わる
    store
        .apply_command(set("com.a", PluginScope::Project, "", "k", r#"{"x":[1]}"#))
        .unwrap();
    assert_eq!(
        value(&store, "com.a", PluginScope::Project, ""),
        Some(r#"{"x":[1]}"#.into())
    );
}

#[test]
fn it_is_not_undoable_but_counts_as_unsaved_and_survives_a_save() {
    let dir = support::TempDir::new();
    let mut store = create_and_open(&dir);
    assert_eq!(store.save_state().unsaved_count, 0);
    store
        .apply_command(set("com.a", PluginScope::Project, "", "k", "\"v\""))
        .unwrap();
    // Undo に積まれない
    assert!(store.undo().unwrap().is_none());
    // 未保存に数える（保存の対象になる）
    let state = store.save_state();
    assert!(state.dirty && state.unsaved_count == 1);
    save_and_close(store);
    let saved = read_saved_conn(dir.path());
    assert_eq!(support::count(&saved, "plugin_data"), 1);
    // 開き直しても読める
    let reopened = open_store(dir.path());
    assert_eq!(
        reopened
            .plugin_value("com.a", PluginScope::Project, "", "k")
            .unwrap(),
        Some("\"v\"".into())
    );
}

#[test]
fn undo_does_not_touch_plugin_data_written_after_a_command() {
    let (_dir, mut store) = new_project(&["a1"]);
    store
        .apply_command(support::create_annotation("a1", "{}"))
        .unwrap();
    store
        .apply_command(set("com.a", PluginScope::Project, "", "k", "1"))
        .unwrap();
    store.undo().unwrap().expect("注釈の作成を戻せる");
    assert_eq!(
        store
            .plugin_value("com.a", PluginScope::Project, "", "k")
            .unwrap(),
        Some("1".into())
    );
}

#[test]
fn invalid_input_is_refused() {
    let (_dir, mut store) = new_project(&["a1"]);
    for bad in [
        set("", PluginScope::Project, "", "k", "1"),
        set("com.a", PluginScope::Project, "", "", "1"),
        set("com.a", PluginScope::Project, "x", "k", "1"),
        set("com.a", PluginScope::Asset, "", "k", "1"),
        set("com.a", PluginScope::Project, "", "k", "{oops"),
        set(
            "com.a",
            PluginScope::Project,
            "",
            "k",
            &format!("\"{}\"", "x".repeat(2 * 1024 * 1024)),
        ),
    ] {
        let error = store.apply_command(bad).unwrap_err();
        assert!(matches!(error, StoreError::InvalidCommand(_)), "{error:?}");
    }
    assert_eq!(store.save_state().unsaved_count, 0);
}
