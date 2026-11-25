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
