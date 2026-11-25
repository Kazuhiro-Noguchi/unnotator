//! 統合テスト共通の準備。一時フォルダ、マニフェストのビルダー、細工した zip を手で書く道具。
//!
//! zip は**外部のクレートを使わずに**書く。書き込み側のクレートは、危ない名前・シンボリックリンク・
//! 重複・偽りのサイズを書かせてくれないので、細工したパッケージを作れない。
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{Value, json};

/// 一時フォルダ。破棄すると中身ごと消える。
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new() -> Self {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "unnotator-ext-test-{}-{}-{n}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&path).expect("一時フォルダを作れる");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// アプリのデータの置き場（`AppPaths::new` の第 1 引数）。
    pub fn data_dir(&self) -> PathBuf {
        let dir = self.path.join("data");
        std::fs::create_dir_all(&dir).expect("作れる");
        dir
    }

    /// アプリのキャッシュの置き場（`AppPaths::new` の第 2 引数）。
    pub fn cache_dir(&self) -> PathBuf {
        let dir = self.path.join("cache");
        std::fs::create_dir_all(&dir).expect("作れる");
        dir
    }
}

impl Default for TempDir {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// ---- マニフェストのビルダー --------------------------------------------------

/// マニフェストを組み立てる。種別名は媒体に依存しない（`text`・`binary` など、抽象的なもの）。
pub struct ManifestBuilder {
    value: Value,
}

pub fn manifest(id: &str, version: &str) -> ManifestBuilder {
    ManifestBuilder {
        value: json!({
            "id": id,
            "version": version,
            "engines": { "unnotator": "^1.0.0" },
            "main": "dist/index.js",
            "contributes": {}
        }),
    }
}

impl ManifestBuilder {
    pub fn engine(mut self, range: &str) -> Self {
        self.value["engines"]["unnotator"] = json!(range);
        self
    }

    pub fn dep(mut self, id: &str, range: &str) -> Self {
        let deps = self.value["extensionDependencies"].take();
        let mut map = deps.as_object().cloned().unwrap_or_default();
        map.insert(id.to_owned(), json!(range));
        self.value["extensionDependencies"] = Value::Object(map);
        self
    }

    pub fn permissions(mut self, permissions: &[&str]) -> Self {
        self.value["permissions"] = json!(permissions);
        self
    }

    pub fn display_name(mut self, name: &str) -> Self {
        self.value["displayName"] = json!(name);
        self
    }

    /// 媒体種別を 1 つ足す。
    pub fn media_type(self, local: &str, extensions: &[&str], mime_types: &[&str]) -> Self {
        let mut item = json!({ "id": local, "title": local });
        if !extensions.is_empty() {
            item["extensions"] = json!(extensions);
        }
        if !mime_types.is_empty() {
            item["mimeTypes"] = json!(mime_types);
        }
        self.push("mediaTypes", item)
    }

    pub fn editor(self, local: &str, media_types: &[&str]) -> Self {
        self.push(
            "editors",
            json!({ "id": local, "title": local, "mediaTypes": media_types }),
        )
    }

    pub fn annotation_type(self, local: &str, media_types: &[&str]) -> Self {
        self.push(
            "annotationTypes",
            json!({
                "id": local, "version": 1, "title": local, "mediaTypes": media_types,
                "selectorSchema": { "type": "object" }
            }),
        )
    }

    pub fn tool(self, local: &str, editor: &str, annotation_type: &str) -> Self {
        self.push(
            "tools",
            json!({
                "id": local, "editor": editor, "annotationType": annotation_type,
                "title": local, "icon": "icons/tool.svg"
            }),
        )
    }

    /// 任意の宣言を、`contributes.<kind>` に足す。
    pub fn push(mut self, kind: &str, item: Value) -> Self {
        let list = self.value["contributes"][kind].take();
        let mut items = list.as_array().cloned().unwrap_or_default();
        items.push(item);
        self.value["contributes"][kind] = Value::Array(items);
        self
    }

    /// 任意の項目を、トップレベルに書く。
    pub fn set(mut self, key: &str, value: Value) -> Self {
        self.value[key] = value;
        self
    }

    pub fn build(self) -> Value {
        self.value
    }

    pub fn bytes(self) -> Vec<u8> {
        serde_json::to_vec_pretty(&self.value).expect("JSON にできる")
    }
}

/// 拡張機能のフォルダを `<root>/<id>/<version>/` に書く（zip を使わずに「導入済み」を用意する）。
/// `files` は `(相対パス, 中身)`。マニフェストと `dist/index.js` は自動で書く。
pub fn write_extension(root: &Path, manifest: &Value, files: &[(&str, &[u8])]) -> PathBuf {
    let id = manifest["id"].as_str().expect("id がある");
    let version = manifest["version"].as_str().expect("version がある");
    let dir = root.join(id).join(version);
    std::fs::create_dir_all(dir.join("dist")).expect("作れる");
    std::fs::write(
        dir.join("unnotator-plugin.json"),
        serde_json::to_vec_pretty(manifest).expect("JSON にできる"),
    )
    .expect("書ける");
    std::fs::write(
        dir.join("dist/index.js"),
        b"export function activate() {}\n",
    )
    .expect("書ける");
    for (rel, bytes) in files {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("作れる");
        }
        std::fs::write(path, bytes).expect("書ける");
    }
    dir
}

// ---- zip を手で書く ---------------------------------------------------------

const UNIX: u16 = 3 << 8;

/// 1 つのエントリ。名前・モード・サイズ・CRC を、偽ることもできる。
pub struct RawEntry {
    pub name: String,
    /// 圧縮された本体（method が 0 なら、そのままの中身）。
    pub data: Vec<u8>,
    /// 0 = 保存、8 = deflate。
    pub method: u16,
    /// 宣言する展開後のサイズ。`None` なら、`data.len()`（保存のとき）。
    pub declared_size: Option<u32>,
    /// 宣言する CRC。`None` なら、中身から計算する（保存のとき）。
    pub declared_crc: Option<u32>,
    /// 外部属性（上位 16 ビットが Unix のモード）。
    pub external_attrs: u32,
}

impl RawEntry {
    pub fn file(name: &str, bytes: &[u8]) -> Self {
        Self {
            name: name.to_owned(),
            data: bytes.to_vec(),
            method: 0,
            declared_size: None,
            declared_crc: None,
            external_attrs: 0o100644 << 16,
        }
    }

    pub fn dir(name: &str) -> Self {
        let mut name = name.to_owned();
        if !name.ends_with('/') {
            name.push('/');
        }
        Self {
            name,
            data: Vec::new(),
            method: 0,
            declared_size: None,
            declared_crc: None,
            external_attrs: 0o040755 << 16,
        }
    }

    /// シンボリックリンク（本体はリンク先のパス）。
    pub fn symlink(name: &str, target: &str) -> Self {
        let mut e = Self::file(name, target.as_bytes());
        e.external_attrs = 0o120777 << 16;
        e
    }

    pub fn with_mode(mut self, mode: u32) -> Self {
        self.external_attrs = mode << 16;
        self
    }

    /// 展開すると `size` バイトの 0 になる、deflate のエントリ（展開爆弾）。
    /// `declared_size` で、宣言するサイズを偽れる。
    pub fn zeros_bomb(name: &str, size: u64, declared_size: Option<u32>) -> Self {
        let (data, crc) = deflate_zeros(size);
        Self {
            name: name.to_owned(),
            data,
            method: 8,
            declared_size: Some(declared_size.unwrap_or(u32::try_from(size).unwrap_or(u32::MAX))),
            declared_crc: Some(crc),
            external_attrs: 0o100644 << 16,
        }
    }
}

/// 有効なマニフェストと `dist/index.js` を持つ、最小のパッケージのエントリ。
pub fn minimal_package(manifest: &Value) -> Vec<RawEntry> {
    vec![
        RawEntry::file(
            "unnotator-plugin.json",
            &serde_json::to_vec_pretty(manifest).expect("JSON にできる"),
        ),
        RawEntry::file("dist/index.js", b"export function activate() {}\n"),
    ]
}

/// zip のバイト列を作る。
pub fn build_zip(entries: &[RawEntry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for entry in entries {
        let offset = u32::try_from(out.len()).expect("小さい");
        let crc = entry.declared_crc.unwrap_or_else(|| crc32(&entry.data));
        let size = entry
            .declared_size
            .unwrap_or_else(|| u32::try_from(entry.data.len()).expect("小さい"));
        let csize = u32::try_from(entry.data.len()).expect("小さい");
        let name = entry.name.as_bytes();
        let name_len = u16::try_from(name.len()).expect("短い");

        out.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
        out.extend_from_slice(&20_u16.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes()); // flags
        out.extend_from_slice(&entry.method.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes()); // time
        out.extend_from_slice(&0x21_u16.to_le_bytes()); // date（1980-01-01）
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&csize.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0_u16.to_le_bytes()); // extra
        out.extend_from_slice(name);
        out.extend_from_slice(&entry.data);

        central.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
        central.extend_from_slice(&(UNIX | 20).to_le_bytes());
        central.extend_from_slice(&20_u16.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&entry.method.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes());
        central.extend_from_slice(&0x21_u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&csize.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&0_u16.to_le_bytes()); // extra
        central.extend_from_slice(&0_u16.to_le_bytes()); // comment
        central.extend_from_slice(&0_u16.to_le_bytes()); // disk
        central.extend_from_slice(&0_u16.to_le_bytes()); // internal attrs
        central.extend_from_slice(&entry.external_attrs.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }
    let central_offset = u32::try_from(out.len()).expect("小さい");
    let central_size = u32::try_from(central.len()).expect("小さい");
    out.extend_from_slice(&central);
    let count = u16::try_from(entries.len()).expect("少ない");
    out.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0_u16.to_le_bytes());
    out
}

/// zip を、ファイルに書く。
pub fn write_zip(path: &Path, entries: &[RawEntry]) {
    std::fs::write(path, build_zip(entries)).expect("書ける");
}

pub fn crc32(data: &[u8]) -> u32 {
    crc32_update(0, data)
}

fn crc32_update(prev: u32, data: &[u8]) -> u32 {
    let mut crc = !prev;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            let mask = (!(crc & 1)).wrapping_add(1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

/// 長さ `size` の 0 を、固定ハフマンの deflate で表す（1 つの一致 = 258 バイト）。
/// 戻り値は（圧縮データ、展開後の CRC）。
fn deflate_zeros(size: u64) -> (Vec<u8>, u32) {
    struct Bits {
        bytes: Vec<u8>,
        acc: u32,
        n: u32,
    }
    impl Bits {
        /// 下位ビットから詰める（ハフマン符号以外の値）。
        fn put(&mut self, value: u32, count: u32) {
            for i in 0..count {
                self.bit((value >> i) & 1);
            }
        }
        /// ハフマン符号は、上位ビットから詰める。
        fn code(&mut self, value: u32, count: u32) {
            for i in (0..count).rev() {
                self.bit((value >> i) & 1);
            }
        }
        fn bit(&mut self, b: u32) {
            self.acc |= b << self.n;
            self.n += 1;
            if self.n == 8 {
                self.bytes.push(u8::try_from(self.acc).expect("8 ビット"));
                self.acc = 0;
                self.n = 0;
            }
        }
        fn finish(mut self) -> Vec<u8> {
            if self.n > 0 {
                self.bytes.push(u8::try_from(self.acc).expect("8 ビット"));
            }
            self.bytes
        }
    }

    let mut bits = Bits {
        bytes: Vec::new(),
        acc: 0,
        n: 0,
    };
    bits.put(1, 1); // BFINAL
    bits.put(1, 2); // BTYPE = 01（固定ハフマン）
    if size > 0 {
        bits.code(0x30, 8); // リテラル 0
        let mut remaining = size - 1;
        while remaining >= 258 {
            bits.code(0xC5, 8); // 長さ 258（記号 285）
            bits.code(0, 5); // 距離 1
            remaining -= 258;
        }
        // 端数は、リテラルの 0 で埋める
        while remaining > 0 {
            bits.code(0x30, 8);
            remaining -= 1;
        }
    }
    bits.code(0, 7); // 終わり（記号 256）
    let data = bits.finish();

    // 0 の CRC は、同じ長さの 0 の列を順に更新して求める
    let zeros = [0_u8; 65_536];
    let mut crc = 0;
    let mut left = size;
    while left > 0 {
        let take = usize::try_from(left.min(65_536)).expect("小さい");
        crc = crc32_update(crc, &zeros[..take]);
        left -= take as u64;
    }
    (data, crc)
}

#[cfg(test)]
mod self_tests {
    use super::*;

    #[test]
    fn crc32_matches_the_known_value() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn a_zip_has_the_central_directory_signature() {
        let zip = build_zip(&[RawEntry::file("a.txt", b"hi")]);
        assert!(zip.windows(4).any(|w| w == 0x0201_4b50_u32.to_le_bytes()));
    }
}
