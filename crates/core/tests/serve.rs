//! US6: `unno://` の配信の本体（URL・閉じ込め・Range・予算）（spec.md US6、research.md R9、contracts/protocol.md）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::Path;
use std::time::Duration;

use support::TempDir;
use unnotator_core::serve::{
    Budget, RangeOutcome, ResponseContext, ResponseLimits, ServeError, Target, confine_inside,
    confine_no_links, parse_range, parse_target, respond_file,
};

// ---- URL の解釈 ----

#[test]
fn the_four_kinds_are_recognized() {
    assert_eq!(
        parse_target("/asset/abc-123").unwrap(),
        Target::Asset("abc-123".into())
    );
    assert_eq!(
        parse_target("/preview/abc").unwrap(),
        Target::Preview("abc".into())
    );
    assert_eq!(
        parse_target("/blob/out.bin").unwrap(),
        Target::Blob("out.bin".into())
    );
    assert_eq!(
        parse_target("/ext/com.example.text/dist/index.js").unwrap(),
        Target::Ext {
            id: "com.example.text".into(),
            rest: vec!["dist".into(), "index.js".into()]
        }
    );
}

#[test]
fn a_query_and_a_fragment_are_not_part_of_the_path() {
    assert_eq!(
        parse_target("/asset/abc?t=1").unwrap(),
        Target::Asset("abc".into())
    );
    assert_eq!(
        parse_target("/asset/abc#top").unwrap(),
        Target::Asset("abc".into())
    );
}

#[test]
fn percent_escapes_are_resolved_once_per_segment() {
    assert_eq!(
        parse_target("/ext/a.b/%E6%97%A5%E6%9C%AC.js").unwrap(),
        Target::Ext {
            id: "a.b".into(),
            rest: vec!["日本.js".into()]
        }
    );
    // 二重に包まれたものは、1 回だけ展開され、名前として残る（2 回目は展開しない）
    assert_eq!(
        parse_target("/blob/%252e%252e").unwrap(),
        Target::Blob("%2e%2e".into())
    );
}

#[test]
fn malformed_and_unknown_paths_are_bad_requests() {
    for bad in [
        "",
        "/",
        "asset/x",
        "/asset",
        "/asset/",
        "/asset/a/b",
        "/preview",
        "/blob",
        "/blob/a/b",
        "/ext",
        "/ext/id",
        "/ext/id/",
        "/other/x",
        "//asset/x",
        "/asset//x",
        "/ext/id//x",
    ] {
        assert!(
            matches!(parse_target(bad), Err(ServeError::BadRequest(_))),
            "{bad:?} は拒む: {:?}",
            parse_target(bad)
        );
    }
}

#[test]
fn escape_attempts_are_rejected_in_every_encoding() {
    let attempts = [
        "/asset/..",
        "/asset/%2e%2e",
        "/asset/%2E%2E",
        "/asset/.",
        "/ext/id/..",
        "/ext/id/../../secret",
        "/ext/id/%2e%2e/%2e%2e/secret",
        "/ext/id/.%2e/secret",
        "/ext/id/a%2fb",
        "/ext/id/a%2Fb",
        "/ext/id/a%5cb",
        "/ext/id/a%5Cb",
        "/ext/id/a\\b",
        "/ext/id/..\\..\\x",
        "/ext/id/./x",
        "/ext/id/C:/windows",
        "/ext/id/c%3a/x",
        "/ext/id/x:stream",
        "/blob/%00",
        "/blob/a%00b",
        "/blob/a%0ab",
        "/blob/a%1fb",
        "/blob/a%7fb",
        "/ext/id/%C0%AF",
        "/ext/id/%ff",
        "/ext/id/%E3%81",
        "/blob/%2",
        "/blob/%zz",
    ];
    assert!(attempts.len() >= 20);
    for attempt in attempts {
        assert!(
            parse_target(attempt).is_err(),
            "{attempt:?} は拒まれなければならない: {:?}",
            parse_target(attempt)
        );
    }
}

#[test]
fn length_limits_apply() {
    let long_segment = format!("/blob/{}", "a".repeat(256));
    assert!(parse_target(&long_segment).is_err());
    assert!(parse_target(&format!("/blob/{}", "a".repeat(255))).is_ok());
    let long_path = format!("/ext/id/{}", "a/".repeat(2_100));
    assert!(parse_target(&long_path).is_err());
}

// ---- 閉じ込め ----

fn tree(tmp: &TempDir) -> std::path::PathBuf {
    let root = tmp.path().join("root");
    std::fs::create_dir_all(root.join("dist")).unwrap();
    std::fs::write(root.join("dist/index.js"), "x").unwrap();
    std::fs::write(tmp.path().join("secret.txt"), "secret").unwrap();
    root
}

fn segs(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn a_plain_file_is_found_and_a_missing_one_is_not() {
    let tmp = TempDir::new();
    let root = tree(&tmp);
    assert!(confine_no_links(&root, &segs(&["dist", "index.js"])).is_ok());
    assert!(matches!(
        confine_no_links(&root, &segs(&["dist", "nope.js"])),
        Err(ServeError::NotFound)
    ));
}

#[cfg(unix)]
#[test]
fn links_are_refused_in_ext_and_blob_places() {
    use std::os::unix::fs::symlink;
    let tmp = TempDir::new();
    let root = tree(&tmp);
    symlink(tmp.path().join("secret.txt"), root.join("dist/leak.txt")).unwrap();
    symlink(tmp.path(), root.join("outside")).unwrap();
    symlink(root.join("dist/index.js"), root.join("dist/inside.js")).unwrap();
    assert!(matches!(
        confine_no_links(&root, &segs(&["dist", "leak.txt"])),
        Err(ServeError::Forbidden)
    ));
    assert!(matches!(
        confine_no_links(&root, &segs(&["outside", "secret.txt"])),
        Err(ServeError::Forbidden)
    ));
    // 中を指していても、リンクは辿らない
    assert!(matches!(
        confine_no_links(&root, &segs(&["dist", "inside.js"])),
        Err(ServeError::Forbidden)
    ));
}

#[test]
fn an_asset_must_stay_inside_its_root_and_never_inside_the_project_folder_of_the_app() {
    let tmp = TempDir::new();
    let root = tree(&tmp);
    std::fs::create_dir_all(root.join(".unnotator")).unwrap();
    std::fs::write(root.join(".unnotator/project.db"), "db").unwrap();
    assert!(confine_inside(&root, "dist/index.js").is_ok());
    assert!(matches!(
        confine_inside(&root, ".unnotator/project.db"),
        Err(ServeError::Forbidden)
    ));
    assert!(matches!(
        confine_inside(&root, "../secret.txt"),
        Err(ServeError::Forbidden)
    ));
    assert!(matches!(
        confine_inside(&root, "dist/../../secret.txt"),
        Err(ServeError::Forbidden)
    ));
    assert!(matches!(
        confine_inside(&root, "/etc/passwd"),
        Err(ServeError::Forbidden)
    ));
    assert!(matches!(
        confine_inside(&root, "nope.bin"),
        Err(ServeError::NotFound)
    ));
}

#[cfg(unix)]
#[test]
fn an_asset_link_that_leaves_the_root_is_refused() {
    use std::os::unix::fs::symlink;
    let tmp = TempDir::new();
    let root = tree(&tmp);
    symlink(tmp.path().join("secret.txt"), root.join("leak.txt")).unwrap();
    symlink(root.join("dist/index.js"), root.join("ok.js")).unwrap();
    assert!(matches!(
        confine_inside(&root, "leak.txt"),
        Err(ServeError::Forbidden)
    ));
    assert!(
        confine_inside(&root, "ok.js").is_ok(),
        "中を指すリンクは通る"
    );
}

// ---- Range ----

#[test]
fn range_headers_are_parsed() {
    use RangeOutcome::{Full, Partial, Unsatisfiable};
    let p = |h: Option<&str>, len: u64| parse_range(h, len);
    assert_eq!(p(None, 100), Full);
    assert_eq!(p(Some("bytes=0-9"), 100), Partial { start: 0, end: 9 });
    assert_eq!(p(Some("bytes=10-"), 100), Partial { start: 10, end: 99 });
    assert_eq!(p(Some("bytes=-10"), 100), Partial { start: 90, end: 99 });
    assert_eq!(
        p(Some("bytes=-1000"), 100),
        Partial { start: 0, end: 99 },
        "長さを超える接尾は、全体"
    );
    assert_eq!(
        p(Some("bytes=90-1000"), 100),
        Partial { start: 90, end: 99 },
        "終わりは長さに丸める"
    );
    assert_eq!(p(Some("bytes=100-"), 100), Unsatisfiable);
    assert_eq!(p(Some("bytes=100-200"), 100), Unsatisfiable);
    assert_eq!(p(Some("bytes=5-2"), 100), Unsatisfiable, "不正な範囲は断る");
    assert_eq!(p(Some("bytes=-0"), 100), Unsatisfiable);
    assert_eq!(
        p(Some("bytes=0-1,3-4"), 100),
        Unsatisfiable,
        "複数の範囲は対応しない"
    );
    assert_eq!(p(Some("bytes="), 100), Unsatisfiable);
    assert_eq!(p(Some("bytes=a-b"), 100), Unsatisfiable);
    assert_eq!(
        p(Some("bytes=0-1"), 0),
        Unsatisfiable,
        "空のファイルに範囲は無い"
    );
    assert_eq!(p(Some("items=0-1"), 100), Full, "知らない単位は無視する");
    assert_eq!(p(Some("bytes=18446744073709551615-"), 100), Unsatisfiable);
    assert_eq!(
        p(Some("bytes=0-18446744073709551615"), 100),
        Partial { start: 0, end: 99 }
    );
    assert_eq!(
        p(Some(" bytes=0-9 "), 100),
        Partial { start: 0, end: 9 },
        "前後の空白は許す"
    );
}

// ---- 応答 ----

fn file_with(tmp: &TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let path = tmp.path().join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

fn numbered(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

fn ctx(content_type: &str) -> ResponseContext<'_> {
    ResponseContext::new(content_type)
}

#[test]
fn the_whole_file_is_returned_with_standard_headers() {
    let tmp = TempDir::new();
    let bytes = numbered(1_000);
    let path = file_with(&tmp, "a.bin", &bytes);
    let mut c = ctx("application/x-test");
    c.etag = true;
    let response = respond_file(&path, &c);
    assert_eq!(response.status, 200);
    assert_eq!(response.body, bytes);
    assert_eq!(response.header("content-type"), Some("application/x-test"));
    assert_eq!(response.header("content-length"), Some("1000"));
    assert_eq!(response.header("accept-ranges"), Some("bytes"));
    assert_eq!(response.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(
        response.header("cross-origin-resource-policy"),
        Some("cross-origin")
    );
    assert_eq!(response.header("access-control-allow-origin"), Some("*"));
    assert!(
        response
            .header("access-control-expose-headers")
            .unwrap()
            .contains("Content-Range")
    );
    assert_eq!(response.header("cache-control"), Some("no-cache"));
    assert!(response.header("etag").unwrap().starts_with('"'));
}

#[test]
fn a_range_returns_206_with_content_range_and_only_that_part() {
    let tmp = TempDir::new();
    let bytes = numbered(1_000);
    let path = file_with(&tmp, "a.bin", &bytes);
    for (header, start, end) in [
        ("bytes=10-19", 10, 19),
        ("bytes=990-", 990, 999),
        ("bytes=-5", 995, 999),
    ] {
        let mut c = ctx("application/x-test");
        c.range = Some(header);
        let r = respond_file(&path, &c);
        assert_eq!(r.status, 206, "{header}");
        assert_eq!(r.body, &bytes[start..=end], "{header}");
        assert_eq!(
            r.header("content-range"),
            Some(format!("bytes {start}-{end}/1000").as_str()),
            "{header}"
        );
        assert_eq!(
            r.header("content-length"),
            Some((end - start + 1).to_string().as_str())
        );
    }
}

#[test]
fn an_unsatisfiable_range_is_416_with_the_total_length() {
    let tmp = TempDir::new();
    let path = file_with(&tmp, "a.bin", &numbered(100));
    for header in ["bytes=100-", "bytes=500-600", "bytes=5-2", "bytes=0-1,3-4"] {
        let mut c = ctx("application/x-test");
        c.range = Some(header);
        let r = respond_file(&path, &c);
        assert_eq!(r.status, 416, "{header}");
        assert_eq!(r.header("content-range"), Some("bytes */100"), "{header}");
        assert!(r.body.len() < 100, "本文は短い説明だけ");
    }
}

#[test]
fn a_big_range_is_cut_to_the_chunk_size() {
    let tmp = TempDir::new();
    let bytes = numbered(10_000);
    let path = file_with(&tmp, "a.bin", &bytes);
    let mut c = ctx("application/x-test");
    c.limits = ResponseLimits {
        chunk: 1_000,
        full: 5_000,
    };
    c.range = Some("bytes=0-");
    let r = respond_file(&path, &c);
    assert_eq!(r.status, 206);
    assert_eq!(r.body.len(), 1_000);
    assert_eq!(r.header("content-range"), Some("bytes 0-999/10000"));
    c.range = Some("bytes=9500-");
    let r = respond_file(&path, &c);
    assert_eq!(r.body, &bytes[9_500..]);
    assert_eq!(r.header("content-range"), Some("bytes 9500-9999/10000"));
}

#[test]
fn a_whole_file_over_the_limit_is_413_and_a_range_still_works() {
    let tmp = TempDir::new();
    let path = file_with(&tmp, "a.bin", &numbered(10_000));
    let mut c = ctx("application/x-test");
    c.limits = ResponseLimits {
        chunk: 1_000,
        full: 5_000,
    };
    let r = respond_file(&path, &c);
    assert_eq!(r.status, 413);
    c.range = Some("bytes=0-9");
    assert_eq!(respond_file(&path, &c).status, 206);
}

#[test]
fn an_etag_match_is_304_and_head_has_no_body() {
    let tmp = TempDir::new();
    let path = file_with(&tmp, "a.bin", &numbered(100));
    let mut c = ctx("application/x-test");
    c.etag = true;
    let etag = respond_file(&path, &c).header("etag").unwrap().to_owned();
    c.if_none_match = Some(&etag);
    let r = respond_file(&path, &c);
    assert_eq!(r.status, 304);
    assert!(r.body.is_empty());
    c.if_none_match = Some("\"other\"");
    assert_eq!(respond_file(&path, &c).status, 200);
    c.if_none_match = None;
    c.head = true;
    let r = respond_file(&path, &c);
    assert_eq!(r.status, 200);
    assert!(r.body.is_empty());
    assert_eq!(r.header("content-length"), Some("100"));
}

#[test]
fn failures_do_not_leak_paths_or_other_data() {
    let tmp = TempDir::new();
    let secret_dir = tmp.path().join("very-secret-folder");
    std::fs::create_dir_all(&secret_dir).unwrap();
    let missing = secret_dir.join("missing.bin");
    let r = respond_file(&missing, &ctx("application/x-test"));
    assert_eq!(r.status, 404);
    let text = String::from_utf8_lossy(&r.body).to_lowercase();
    assert!(
        !text.contains("secret") && !text.contains("missing") && !text.contains("tmp"),
        "{text}"
    );
    assert_eq!(r.header("x-content-type-options"), Some("nosniff"));
    // フォルダは、ファイルとして返さない
    assert_eq!(
        respond_file(&secret_dir, &ctx("application/x-test")).status,
        404
    );
}

#[test]
fn extra_headers_are_added() {
    let tmp = TempDir::new();
    let path = file_with(&tmp, "a.html", b"<p>hi</p>");
    let mut c = ctx("text/html; charset=utf-8");
    c.extra_headers = vec![(
        "Content-Security-Policy".into(),
        "default-src 'none'".into(),
    )];
    let r = respond_file(&path, &c);
    assert_eq!(
        r.header("content-security-policy"),
        Some("default-src 'none'")
    );
}

#[test]
fn reading_a_big_sparse_file_by_range_does_not_load_all_of_it() {
    // 1 GiB の疎なファイル。末尾の 16 バイトだけを読む（全体を読めば、時間とメモリで分かる）
    let tmp = TempDir::new();
    let path = tmp.path().join("sparse.bin");
    {
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(1 << 30).unwrap();
    }
    let mut c = ctx("application/x-test");
    c.range = Some("bytes=-16");
    let started = std::time::Instant::now();
    let r = respond_file(&path, &c);
    assert_eq!(r.status, 206);
    assert_eq!(r.body.len(), 16);
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        r.header("content-range"),
        Some(
            format!(
                "bytes {}-{}/{}",
                (1u64 << 30) - 16,
                (1u64 << 30) - 1,
                1u64 << 30
            )
            .as_str()
        )
    );
}

// ---- バイト予算 ----

#[test]
fn the_budget_limits_bytes_and_concurrent_requests() {
    let budget = Budget::new(100, 2);
    let wait = Duration::from_millis(30);
    assert!(
        matches!(budget.acquire(150, wait), Err(ServeError::TooLarge)),
        "1 件で予算を超える"
    );
    let first = budget.acquire(60, wait).unwrap();
    assert!(
        matches!(budget.acquire(60, wait), Err(ServeError::Busy)),
        "残りが足りない間は待ち、時間切れ"
    );
    let second = budget.acquire(40, wait).unwrap();
    assert!(
        matches!(budget.acquire(1, wait), Err(ServeError::Busy)),
        "同時数の上限（2）"
    );
    drop(first);
    let third = budget.acquire(60, wait).unwrap();
    drop(second);
    drop(third);
    assert!(budget.acquire(100, wait).is_ok(), "全部返せば、また使える");
}

#[test]
fn a_waiting_request_proceeds_when_bytes_are_returned() {
    let budget = std::sync::Arc::new(Budget::new(100, 4));
    let held = budget.acquire(80, Duration::from_millis(10)).unwrap();
    let waiter = {
        let budget = std::sync::Arc::clone(&budget);
        std::thread::spawn(move || budget.acquire(50, Duration::from_secs(5)).is_ok())
    };
    std::thread::sleep(Duration::from_millis(50));
    drop(held);
    assert!(waiter.join().unwrap(), "返されたら進む");
}

#[allow(dead_code)]
fn _unused(_: &Path) {}
