//! US4: 保存している間も編集を続けられる（spec.md US4、FR-013・FR-014、SC-006）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::sync::mpsc;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use support::{TempDir, create_label, read_conn, read_saved_conn};
use unnotator_core::project::ProjectStore;
use unnotator_core::project::save::SaveStage;

#[test]
fn begin_save_twice_is_refused_until_the_first_save_ends() {
    let (_dir, mut store) = support::new_project(&["a1"]);
    store.apply_command(create_label("one")).unwrap();
    let job = store.begin_save().unwrap().expect("未保存がある");
    assert!(store.save_state().saving);
    assert_eq!(store.begin_save().unwrap_err().code(), "already_saving");
    assert_eq!(store.save().unwrap_err().code(), "already_saving");

    let outcome = job.run().unwrap();
    let state = store.finish_save(outcome).unwrap();
    assert!(!state.saving && !state.dirty);
    assert!(store.begin_save().unwrap().is_none());
}

#[test]
fn edits_made_during_a_save_stay_unsaved_and_are_not_in_the_saved_file() {
    let (dir, mut store) = support::new_project(&["a1"]);
    store.apply_command(create_label("before-1")).unwrap();
    store.apply_command(create_label("before-2")).unwrap();
    let job = store.begin_save().unwrap().expect("未保存がある");

    // VACUUM INTO のあと、名前の置き換えの前に、別の編集を差し込む
    let (reached_tx, reached_rx) = mpsc::channel::<()>();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let worker = std::thread::spawn(move || {
        job.run_with_hook(|stage| {
            if stage == SaveStage::AfterVacuum {
                reached_tx.send(()).unwrap();
                go_rx.recv().unwrap();
            }
        })
    });
    reached_rx.recv().unwrap();
    assert!(store.save_state().saving);
    store.apply_command(create_label("during-1")).unwrap();
    store.apply_command(create_label("during-2")).unwrap();
    store.undo().unwrap().unwrap();
    go_tx.send(()).unwrap();
    let outcome = worker.join().unwrap().unwrap();
    let state = store.finish_save(outcome).unwrap();

    // 保存されたのは、保存を始めた時点の内容だけ
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 2);
    // 保存中の編集（2 回の適用と 1 回の Undo）は、未保存として残る
    assert!(state.dirty && !state.saving);
    assert_eq!(state.unsaved_count, 3);
    assert_eq!(support::count(&read_conn(dir.path()), "labels"), 3);
    // 続けて保存すれば、残りも入る
    store.save().unwrap();
    assert_eq!(support::count(&read_saved_conn(dir.path()), "labels"), 3);
    assert!(!store.save_state().dirty);
}

fn bulk_annotations(conn: &Connection, count: usize) {
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO annotations (id, asset_id, type, selector_json, z_order, created_at, updated_at) \
                 VALUES (?1, 'a1', 'com.example.shape/shape', '{\"i\": 1}', ?2, 0, 0)",
            )
            .unwrap();
        for i in 0..count {
            stmt.execute(rusqlite::params![format!("n{i:08}"), i as i64])
                .unwrap();
        }
    }
    tx.commit().unwrap();
}

#[test]
fn edits_are_not_blocked_while_a_large_project_is_being_saved() {
    let dir = TempDir::new();
    ProjectStore::create(dir.path(), support::system_config(dir.path()))
        .unwrap()
        .close(None)
        .unwrap();
    {
        let conn = Connection::open(dir.path().join(".unnotator/project.db")).unwrap();
        support::insert_asset(&conn, "a1", "a.bin");
        bulk_annotations(&conn, 100_000);
    }
    let mut store = support::open_store(dir.path());
    store.apply_command(create_label("first")).unwrap();
    let job = store.begin_save().unwrap().expect("未保存がある");

    let started = Instant::now();
    let worker = std::thread::spawn(move || job.run());
    let mut worst = Duration::ZERO;
    let mut edits = 0;
    while !worker.is_finished() {
        let start = Instant::now();
        store
            .apply_command(create_label(&format!("during-{edits}")))
            .unwrap();
        worst = worst.max(start.elapsed());
        edits += 1;
    }
    let outcome = worker.join().unwrap().unwrap();
    let save_time = started.elapsed();
    store.finish_save(outcome).unwrap();

    println!("保存 {save_time:?}・保存中の編集 {edits} 回・最も長い待ち {worst:?}");
    assert!(edits >= 1, "保存の間に、編集できていない");
    // 編集 1 回の待ちが、保存の時間より十分に短い（保存の終わりを待っていない）。
    // 塞がれていれば、待ちは保存の時間そのものに近づく。共有の CI の 2 コアでは、保存のスレッドと CPU を取り合って
    // 1 回の編集が数十 ms かかることがあるので、基準は「保存の時間の 3/4 未満」にする
    // （実測: 保存 180〜190 ms に対し、最大 70〜90 ms。手元の macOS では、編集の待ちは 20 ms 未満）。
    assert!(
        worst * 4 < save_time * 3 || worst < Duration::from_millis(50),
        "編集が保存に待たされた: 最大 {worst:?}、保存 {save_time:?}"
    );
    assert!(store.save_state().dirty);
}
