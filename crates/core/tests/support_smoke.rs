//! テスト用の準備（`tests/support`）が正しく動くことの確認。

mod support;

use support::{TempDir, empty_project_db, insert_asset, snapshot};

#[test]
fn snapshot_detects_changes() {
    let conn = empty_project_db();
    let before = snapshot(&conn);
    insert_asset(&conn, "a1", "images/a.png");
    let after = snapshot(&conn);
    assert_ne!(before, after);
    conn.execute("DELETE FROM assets WHERE id = 'a1'", [])
        .unwrap();
    assert_eq!(snapshot(&conn), before);
}

#[test]
fn temp_dir_is_removed_on_drop() {
    let path = {
        let dir = TempDir::new();
        assert!(dir.path().is_dir());
        dir.path().to_path_buf()
    };
    assert!(!path.exists());
}

#[test]
fn file_tree_helpers_work() {
    let dir = support::TempDir::new();
    support::write_file(dir.path(), "a/b.txt", b"hello");
    assert_eq!(std::fs::read(dir.path().join("a/b.txt")).unwrap(), b"hello");
    support::touch(dir.path(), "a/b.txt", 1_600_000_000_000);
    let mtime = std::fs::metadata(dir.path().join("a/b.txt"))
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    assert_eq!(mtime, 1_600_000_000_000);
    support::move_file(dir.path(), "a/b.txt", "c/d.txt");
    assert!(dir.path().join("c/d.txt").is_file());
    support::remove_file(dir.path(), "c/d.txt");
    assert!(!dir.path().join("c/d.txt").exists());
}

#[test]
fn read_assets_returns_registered_rows() {
    let (dir, store) = support::new_project(&["a1"]);
    let assets = support::read_assets(dir.path());
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].rel_path, "a1.bin");
    assert!(!assets[0].missing);
    drop(store);
}

#[test]
fn seeded_project_has_labels_annotations_relation_and_group() {
    let (dir, _store, seed) = support::seeded_project();
    let conn = support::read_conn(dir.path());
    let count = |table: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(count("labels"), 3);
    assert_eq!(count("annotations"), 3);
    assert_eq!(count("relations"), 1);
    assert_eq!(count("annotation_groups"), 1);
    assert_eq!(count("group_members"), 2);
    // 分類と、拡張機能が無い種別（未対応になる）の両方がある
    let kinds: Vec<String> = conn
        .prepare("SELECT type FROM annotations ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(kinds.contains(&"core/classification".to_owned()));
    assert!(kinds.contains(&"com.example.shape/shape".to_owned()));
    assert_eq!(seed.labels.len(), 3);
    assert_eq!(seed.assets, vec!["a1".to_owned(), "a2".to_owned()]);
}
