//! 技術検証 S-03: 作業用コピー + `VACUUM INTO` の保存性能（specs/003-save-recovery/spike-s03.md に結果）。
//! 通常のテストでは走らせない。
//!
//! ```text
//! UNNOTATOR_S03_N=1000000 cargo test -p unnotator-core --test spike_s03 --release -- --ignored --nocapture
//! ```
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::cast_possible_wrap)]

mod support;

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rusqlite::Connection;
use support::TempDir;
use unnotator_core::migrations::{PROJECT_V1, RECOVERY_V1};

fn n() -> usize {
    std::env::var("UNNOTATOR_S03_N")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(100_000)
}

fn secs(start: Instant) -> f64 {
    start.elapsed().as_secs_f64()
}

fn mib(path: &Path) -> f64 {
    let wal = path.with_extension("db-wal");
    let size = std::fs::metadata(path).map_or(0, |m| m.len())
        + std::fs::metadata(wal).map_or(0, |m| m.len());
    size as f64 / 1_048_576.0
}

/// 実際の形に近いプロジェクトを作る（アノテーション n 件、関係 n/10 件）。
fn build_project(path: &Path, n: usize) -> f64 {
    let start = Instant::now();
    let conn = Connection::open(path).unwrap();
    conn.execute_batch("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;")
        .unwrap();
    conn.execute_batch(PROJECT_V1).unwrap();
    conn.execute(
        "INSERT INTO assets (id, rel_path, file_size, mtime_ms, created_at, updated_at) VALUES ('a1', 'a.bin', 0, 0, 0, 0)",
        [],
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    {
        let mut ann = tx
            .prepare(
                "INSERT INTO annotations (id, asset_id, type, selector_json, summary, z_order, created_at, updated_at) \
                 VALUES (?1, 'a1', 'com.example.shape/shape', ?2, ?3, ?4, 1700000000000, 1700000000000)",
            )
            .unwrap();
        let mut rel = tx
            .prepare(
                "INSERT INTO relations (id, type, from_id, to_id, created_at, updated_at) \
                 VALUES (?1, 'com.example.rel/link', ?2, ?3, 0, 0)",
            )
            .unwrap();
        let id = |i: usize| format!("00000000-0000-7000-8000-{i:012x}");
        for i in 0..n {
            ann.execute(rusqlite::params![
                id(i),
                format!(
                    "{{\"x\":{},\"y\":{},\"w\":{},\"h\":{}}}",
                    i % 1920,
                    i % 1080,
                    10 + i % 200,
                    10 + i % 100
                ),
                format!("矩形 {} {}", i % 1920, i % 1080),
                i as i64
            ])
            .unwrap();
        }
        for i in (0..n.saturating_sub(1)).step_by(10) {
            rel.execute(rusqlite::params![
                format!("10000000-0000-7000-8000-{i:012x}"),
                id(i),
                id(i + 1)
            ])
            .unwrap();
        }
    }
    tx.commit().unwrap();
    secs(start)
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// 保存（`VACUUM INTO` → 名前の置き換え）にかかる時間。
fn save(working: &Connection, project: &Path) -> (f64, f64) {
    let tmp = project.with_extension("db.saving");
    let _ = std::fs::remove_file(&tmp);
    let start = Instant::now();
    working
        .execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])
        .unwrap();
    let vacuum = secs(start);
    let start = Instant::now();
    std::fs::rename(&tmp, project).unwrap();
    (vacuum, secs(start))
}

#[test]
#[ignore = "技術検証。--ignored で実行する"]
fn s03_save_performance() {
    let n = n();
    println!("=== S-03: アノテーション {n} 件 ===");
    let dir = TempDir::new();
    let project = dir.path().join("project.db");

    let build = build_project(&project, n);
    println!(
        "準備: プロジェクトを作る {build:.2} s / ファイル {:.1} MiB",
        mib(&project)
    );

    // --- 作業用コピーの作り方（開くときに 1 回） ---
    let working = dir.path().join("working.db");
    let start = Instant::now();
    std::fs::copy(&project, &working).unwrap();
    println!("作業用コピー: fs::copy {:.3} s", secs(start));
    std::fs::remove_file(&working).unwrap();

    let start = Instant::now();
    {
        let src = Connection::open(&project).unwrap();
        src.execute("VACUUM INTO ?1", [working.to_string_lossy().as_ref()])
            .unwrap();
    }
    println!("作業用コピー: VACUUM INTO {:.3} s", secs(start));

    // --- 作業用コピーを WAL にして開く ---
    let start = Instant::now();
    let w = Connection::open(&working).unwrap();
    let mode: String = w
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .unwrap();
    w.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;")
        .unwrap();
    println!(
        "作業用コピーを開く（journal_mode={mode}）: {:.3} s",
        secs(start)
    );
    assert_eq!(count(&w, "annotations"), n as i64);

    // --- 保存（編集なし） ---
    let (vacuum, rename) = save(&w, &project);
    println!("保存（編集なし）: VACUUM INTO {vacuum:.3} s + 置き換え {rename:.4} s");

    // --- コマンド 1 回あたりの書き込み（作業用コピー + journal） ---
    let journal_path = dir.path().join("journal.db");
    let journal = Connection::open(&journal_path).unwrap();
    journal.execute_batch(RECOVERY_V1).unwrap();
    journal
        .execute(
            "INSERT INTO session (id, project_root, project_id, opened_at, app_version, pid) VALUES (1, '/x', 'p', 0, '0', 1)",
            [],
        )
        .unwrap();
    for (label, sync) in [
        ("synchronous=NORMAL", "NORMAL"),
        ("synchronous=FULL", "FULL"),
    ] {
        w.execute_batch(&format!("PRAGMA synchronous = {sync};"))
            .unwrap();
        journal
            .execute_batch(&format!(
                "PRAGMA journal_mode = WAL; PRAGMA synchronous = {sync};"
            ))
            .unwrap();
        let rounds: u32 = 300;
        let start = Instant::now();
        for i in 0..rounds {
            w.execute(
                "UPDATE annotations SET summary = ?1 WHERE id = ?2",
                rusqlite::params![
                    format!("edit {i}"),
                    format!("00000000-0000-7000-8000-{:012x}", (i as usize) % n)
                ],
            )
            .unwrap();
            journal
                .execute(
                    "INSERT INTO entries (at, label, command_json, inverse_json) VALUES (0, 'edit', '{\"k\":1}', '{\"k\":2}')",
                    [],
                )
                .unwrap();
        }
        let per = secs(start) / f64::from(rounds) * 1000.0;
        println!("コマンド 1 回（作業用コピー + journal の 2 コミット）: {per:.3} ms [{label}]");
    }
    // macOS の fsync は、既定ではディスクの書き込みキャッシュまで流さない。fullfsync で、停電への強さを上げたときの費用。
    w.execute_batch("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;")
        .unwrap();
    journal
        .execute_batch("PRAGMA synchronous = FULL; PRAGMA fullfsync = ON;")
        .unwrap();
    let start = Instant::now();
    for i in 0..100 {
        w.execute(
            "UPDATE annotations SET summary = ?1 WHERE id = ?2",
            rusqlite::params![
                format!("full {i}"),
                format!("00000000-0000-7000-8000-{i:012x}")
            ],
        )
        .unwrap();
        journal
            .execute(
                "INSERT INTO entries (at, label, command_json, inverse_json) VALUES (0, 'edit', '{\"k\":1}', '{\"k\":2}')",
                [],
            )
            .unwrap();
    }
    println!(
        "コマンド 1 回（fullfsync=ON）: {:.3} ms",
        secs(start) / 100.0 * 1000.0
    );
    w.execute_batch("PRAGMA fullfsync = OFF; PRAGMA synchronous = NORMAL;")
        .unwrap();
    drop(journal);

    // --- 保存中の編集（別スレッドで保存し、その間に編集を続ける） ---
    for (label, mode) in [("WAL", "WAL"), ("DELETE（既定）", "DELETE")] {
        w.query_row(&format!("PRAGMA journal_mode = {mode}"), [], |r| {
            r.get::<_, String>(0)
        })
        .unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let working_path = working.clone();
        let project_path = project.clone();
        let saver = std::thread::spawn(move || {
            let c = Connection::open(&working_path).unwrap();
            started_tx.send(()).unwrap();
            save(&c, &project_path)
        });
        started_rx.recv().unwrap();
        // 保存の文が動き始める（出力の一時ファイルができる）まで待ってから、編集を始める。
        let saving = project.with_extension("db.saving");
        let wait = Instant::now();
        while !saving.exists() && wait.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(5));
        let mut latencies = Vec::new();
        let begin = Instant::now();
        let mut errors = 0;
        while !saver.is_finished() && begin.elapsed() < Duration::from_secs(120) {
            let t = Instant::now();
            let result = w.execute(
                "UPDATE annotations SET summary = 'during save' WHERE id = ?1",
                [format!(
                    "00000000-0000-7000-8000-{:012x}",
                    latencies.len() % n
                )],
            );
            if result.is_err() {
                errors += 1;
            }
            latencies.push(t.elapsed().as_secs_f64() * 1000.0);
            std::thread::sleep(Duration::from_millis(2));
        }
        let (vacuum, _) = saver.join().unwrap();
        // 保存の途中に行った編集は、保存されたファイルに入っていない（保存の指示の時点の内容だけが入る）。
        let leaked: i64 = Connection::open(&project)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM annotations WHERE summary = 'during save'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        println!("  [{label}] 保存されたファイルに入った、保存中の編集: {leaked} 件");
        let saved_mode: String = Connection::open(&project)
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        println!("  [{label}] 保存されたファイルのジャーナルモード: {saved_mode}");
        if mode == "WAL" {
            assert_eq!(leaked, 0);
        }
        let max = latencies.iter().copied().fold(0.0, f64::max);
        let avg = latencies.iter().sum::<f64>() / latencies.len().max(1) as f64;
        println!(
            "保存中の編集 [{label}]: 保存 {vacuum:.3} s の間に編集 {} 回（失敗 {errors}）、1 回あたり 平均 {avg:.2} ms / 最大 {max:.1} ms",
            latencies.len()
        );
    }

    // --- 保存結果の確認 ---
    let saved = Connection::open(&project).unwrap();
    assert_eq!(count(&saved, "annotations"), n as i64);
    let start = Instant::now();
    let check: String = saved
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .unwrap();
    println!(
        "保存したファイルの quick_check: {check}（{:.2} s）/ ファイル {:.1} MiB",
        secs(start),
        mib(&project)
    );
    assert_eq!(check, "ok");
    // WAL の作業用コピーから `VACUUM INTO` した出力の、ジャーナルモード（project.db は補助ファイルを増やしたくない）
    let mode: String = saved
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    println!("保存したファイルのジャーナルモード: {mode}");
    drop(saved);
    let leftovers: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|f| f.starts_with("project.db"))
        .collect();
    println!("project.db の周りのファイル: {leftovers:?}");
}
