//! US6: ブロブの置き場・プレビューのキャッシュ・アセットの実パス（spec.md US6、FR-027）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use support::{TempDir, create_and_open, folder_with_files};
use unnotator_core::assets::scan::ScanScope;
use unnotator_core::assets::{AssetFilter, Page};
use unnotator_core::serve::{AssetFileError, BlobStore, PreviewCache, ServeError};

#[test]
fn opening_a_blob_store_creates_the_folder_and_clear_empties_it() {
    let tmp = TempDir::new();
    let dir = tmp.path().join("blobs");
    let store = BlobStore::open(dir.clone()).unwrap();
    assert!(dir.is_dir());
    std::fs::write(dir.join("a.bin"), "x").unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub/b.bin"), "y").unwrap();
    store.clear().unwrap();
    assert!(dir.is_dir(), "置き場そのものは残る");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
}

#[test]
fn only_a_plain_name_directly_under_the_folder_resolves() {
    let tmp = TempDir::new();
    let dir = tmp.path().join("blobs");
    let store = BlobStore::open(dir.clone()).unwrap();
    std::fs::write(dir.join("out-1.bin"), "x").unwrap();
    assert_eq!(store.resolve("out-1.bin").unwrap(), dir.join("out-1.bin"));
    assert!(matches!(
        store.resolve("missing.bin"),
        Err(ServeError::NotFound)
    ));
    for bad in [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "../x",
        ".hidden",
        "a\u{0}b",
        "c:x",
        &"a".repeat(256),
    ] {
        assert!(
            matches!(store.resolve(bad), Err(ServeError::BadRequest(_))),
            "{bad:?} は拒む"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_link_in_the_blob_folder_is_refused() {
    let tmp = TempDir::new();
    let dir = tmp.path().join("blobs");
    let store = BlobStore::open(dir.clone()).unwrap();
    std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();
    std::os::unix::fs::symlink(tmp.path().join("secret.txt"), dir.join("leak.bin")).unwrap();
    assert!(matches!(
        store.resolve("leak.bin"),
        Err(ServeError::Forbidden)
    ));
}

#[test]
fn a_preview_is_found_by_asset_id_or_is_absent() {
    let tmp = TempDir::new();
    let cache = PreviewCache::new(tmp.path().join("previews"));
    assert!(
        matches!(cache.resolve("asset-1"), Err(ServeError::NotFound)),
        "フォルダが無くても 404"
    );
    std::fs::create_dir_all(tmp.path().join("previews")).unwrap();
    std::fs::write(tmp.path().join("previews/asset-1"), "thumb").unwrap();
    assert_eq!(
        cache.resolve("asset-1").unwrap(),
        tmp.path().join("previews/asset-1")
    );
    assert!(matches!(
        cache.resolve("../x"),
        Err(ServeError::BadRequest(_))
    ));
}

#[test]
fn a_preview_content_type_comes_from_its_side_file() {
    let tmp = TempDir::new();
    let dir = tmp.path().join("previews");
    std::fs::create_dir_all(&dir).unwrap();
    let cache = PreviewCache::new(dir.clone());
    assert_eq!(cache.content_type("a1"), None);
    std::fs::write(dir.join("a1.type"), "application/x-thumb\n").unwrap();
    assert_eq!(
        cache.content_type("a1").as_deref(),
        Some("application/x-thumb")
    );
    std::fs::write(dir.join("a2.type"), "not a type").unwrap();
    assert_eq!(cache.content_type("a2"), None);
    assert_eq!(cache.content_type("../a1"), None);
}

// ---- アセットの実パス ----

fn first_asset_id(store: &unnotator_core::project::ProjectStore) -> String {
    store
        .list_assets(&AssetFilter::default(), &Page::first(10))
        .unwrap()
        .items[0]
        .id
        .clone()
}

#[test]
fn an_asset_resolves_to_its_root_and_relative_path() {
    let dir = folder_with_files(&[("docs/a.txt", "hello")]);
    let mut store = create_and_open(&dir);
    store.scan(ScanScope::Full).unwrap();
    let id = first_asset_id(&store);
    let file = store.asset_file(&id).unwrap();
    assert_eq!(file.rel_path, "docs/a.txt");
    assert_eq!(file.size, 5);
    assert_eq!(
        std::fs::canonicalize(&file.root).unwrap(),
        std::fs::canonicalize(dir.path()).unwrap()
    );
}

#[test]
fn unknown_and_missing_assets_are_not_found() {
    let dir = folder_with_files(&[("a.txt", "x")]);
    let mut store = create_and_open(&dir);
    store.scan(ScanScope::Full).unwrap();
    let id = first_asset_id(&store);
    assert!(matches!(
        store.asset_file("no-such-id"),
        Err(AssetFileError::NotFound)
    ));
    std::fs::remove_file(dir.path().join("a.txt")).unwrap();
    store.scan(ScanScope::Full).unwrap();
    assert!(
        matches!(store.asset_file(&id), Err(AssetFileError::NotFound)),
        "リンク切れは配信しない"
    );
}

#[test]
fn an_asset_under_an_external_root_resolves_from_that_root() {
    let dir = folder_with_files(&[]);
    let external = TempDir::new();
    std::fs::write(external.path().join("e.txt"), "ext").unwrap();
    let mut store = create_and_open(&dir);
    store.set_external_root("shared", external.path()).unwrap();
    store.scan(ScanScope::Full).unwrap();
    let page = store
        .list_assets(&AssetFilter::default(), &Page::first(10))
        .unwrap();
    let row = page
        .items
        .iter()
        .find(|r| r.root_key == "shared")
        .expect("外部ルートのアセット");
    let file = store.asset_file(&row.id).unwrap();
    assert_eq!(file.rel_path, "e.txt");
    assert_eq!(
        std::fs::canonicalize(&file.root).unwrap(),
        std::fs::canonicalize(external.path()).unwrap()
    );
}
