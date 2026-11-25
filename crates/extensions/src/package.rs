//! `.unnoplugin`（zip）の検査と、安全な展開（research.md R1）。
//!
//! 全エントリを先に検査し、作業フォルダ（`extensions/.staging/<一意>/`）に展開し、マニフェストを検証してから、
//! `extensions/<id>/<version>/` へ `rename` する。失敗・中断では、何も残さない（残った作業フォルダは起動時に消す）。

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use unnotator_core::assets::path::nfc;

use crate::error::ExtensionError;
use crate::limits::{
    MAX_COMPONENT_BYTES, MAX_ENTRIES, MAX_FILE_BYTES, MAX_PATH_BYTES, MAX_RATIO, MAX_TOTAL_BYTES,
    RATIO_FLOOR_BYTES,
};
use crate::paths::{AppPaths, check_id, check_version};
use crate::store::read_extension_dir;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallOutcome {
    Installed { id: String, version: String },
    AlreadyInstalled { id: String, version: String },
}

/// テスト用: この段階の直後でプロセスを強制終了する。
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashPoint {
    /// 最初のファイルを書いた後。
    DuringExtract,
    /// 名前の置き換えの直前。
    BeforeRename,
}

fn refuse<T>(why: impl Into<String>) -> Result<T, ExtensionError> {
    Err(ExtensionError::Package(why.into()))
}

/// 展開後の大きさが、圧縮後の大きさに比べて大きすぎるか（小さなファイルは見ない）。
pub fn exceeds_ratio(compressed: u64, actual: u64) -> bool {
    actual > RATIO_FLOOR_BYTES && actual / compressed.max(1) > MAX_RATIO
}

const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// エントリの名前を検査し、`/` で分けた成分を返す（ディレクトリの末尾の `/` は除く）。
fn check_name(name: &str) -> Result<Vec<String>, ExtensionError> {
    if name.len() > MAX_PATH_BYTES {
        return refuse("パスが長すぎます");
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    let mut components = Vec::new();
    for part in trimmed.split('/') {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let bad = part.is_empty()
            || part == "."
            || part == ".."
            || part.len() > MAX_COMPONENT_BYTES
            || part
                .chars()
                .any(|c| matches!(c, '\\' | ':') || c.is_control())
            || part.ends_with('.')
            || part.ends_with(' ')
            || RESERVED.contains(&stem.as_str());
        if bad {
            return refuse(format!("使えない名前です: {name:?}"));
        }
        components.push(part.to_owned());
    }
    Ok(components)
}

struct Planned {
    index: usize,
    components: Vec<String>,
    is_dir: bool,
    declared: u64,
}

fn unique_staging(paths: &AppPaths) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    paths
        .staging_dir()
        .join(format!("{}-{nanos}-{n}", std::process::id()))
}

pub fn install_package(paths: &AppPaths, package: &Path) -> Result<InstallOutcome, ExtensionError> {
    install_package_with_crash(paths, package, None)
}

#[doc(hidden)]
pub fn install_package_with_crash(
    paths: &AppPaths,
    package: &Path,
    crash: Option<CrashPoint>,
) -> Result<InstallOutcome, ExtensionError> {
    let file = std::fs::File::open(package)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| ExtensionError::Package(format!("zip として読めません: {e}")))?;
    // zip クレートは、同じ名前のエントリを 1 つにまとめてしまう。数が合わなければ、重複がある
    if let Some(declared) = declared_entry_count(package)
        && declared != archive.len()
    {
        return refuse("同じ名前のエントリがあります（または、壊れています）");
    }
    let plan = inspect(&mut archive)?;

    let staging = unique_staging(paths);
    std::fs::create_dir_all(&staging)?;
    let result = (|| {
        extract(&mut archive, &plan, &staging, crash)?;
        let raw = read_extension_dir(&staging, crate::registry::Origin::Installed).map_err(
            |problems| {
                ExtensionError::Package(
                    problems
                        .iter()
                        .map(|p| format!("{} {}", p.pointer, p.message))
                        .collect::<Vec<_>>()
                        .join("; "),
                )
            },
        )?;
        let (id, version) = (raw.id.clone(), raw.version.clone());
        check_id(&id)?;
        check_version(&version)?;
        let dest = paths.extension_dir(&id, &version)?;
        if dest.exists() {
            return Ok(InstallOutcome::AlreadyInstalled { id, version });
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if crash == Some(CrashPoint::BeforeRename) {
            std::process::abort();
        }
        std::fs::rename(&staging, &dest)?;
        // フォルダの fsync はしない: 電源断で名前の置き換えが失われても、拡張機能が入っていないだけで、
        // 利用者のデータは失われない（取り込み直せる）。100 件の取り込みの時間（SC-001）にも効く。
        Ok(InstallOutcome::Installed { id, version })
    })();
    // 置き換えられなかった（失敗・既にある）作業フォルダは消す
    if staging.exists() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// 全エントリを、展開せずに検査する。
fn inspect(archive: &mut zip::ZipArchive<std::fs::File>) -> Result<Vec<Planned>, ExtensionError> {
    if archive.len() > MAX_ENTRIES {
        return refuse("エントリが多すぎます");
    }
    let mut plan = Vec::with_capacity(archive.len());
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut file_keys: Vec<String> = Vec::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|e| ExtensionError::Package(format!("エントリを読めません: {e}")))?;
        let name = entry
            .name()
            .map_err(|e| ExtensionError::Package(format!("名前を読めません: {e}")))?
            .into_owned();
        let components = check_name(&name)?;
        if let Some(mode) = entry.unix_mode() {
            let kind = mode & 0o170_000;
            if kind != 0 && kind != 0o100_000 && kind != 0o040_000 {
                return refuse(format!(
                    "通常のファイルでもフォルダでもありません: {name:?}"
                ));
            }
        }
        if entry.is_symlink() {
            return refuse(format!("シンボリックリンクは取り込めません: {name:?}"));
        }
        let is_dir = entry.is_dir();
        // NFC にして、大文字小文字を畳んだ形で、衝突を見る（重複・正規化・大文字小文字）
        let key = components
            .iter()
            .map(|c| nfc(c).to_lowercase())
            .collect::<Vec<_>>()
            .join("/");
        if !seen.insert(key.clone()) {
            return refuse(format!("同じ名前のエントリがあります: {name:?}"));
        }
        let declared = entry.size();
        if !is_dir {
            if declared > MAX_FILE_BYTES {
                return refuse(format!("ファイルが大きすぎます: {name:?}"));
            }
            total = total.saturating_add(declared);
            if total > MAX_TOTAL_BYTES {
                return refuse("展開後の合計が大きすぎます");
            }
            if exceeds_ratio(entry.compressed_size(), declared) {
                return refuse(format!("圧縮率が高すぎます: {name:?}"));
            }
            file_keys.push(key);
        }
        plan.push(Planned {
            index,
            components,
            is_dir,
            declared,
        });
    }
    // ファイルと同じ名前のフォルダ（または、その下）があってはならない
    for file in &file_keys {
        let prefix = format!("{file}/");
        if seen.iter().any(|k| k.starts_with(&prefix)) {
            return refuse("ファイルとフォルダが同じ名前です");
        }
    }
    Ok(plan)
}

fn extract(
    archive: &mut zip::ZipArchive<std::fs::File>,
    plan: &[Planned],
    staging: &Path,
    crash: Option<CrashPoint>,
) -> Result<(), ExtensionError> {
    let mut total = 0u64;
    let mut wrote_first = false;
    for item in plan {
        let mut target = staging.to_path_buf();
        for c in &item.components {
            target.push(c);
        }
        if item.is_dir {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut entry = archive
            .by_index(item.index)
            .map_err(|e| ExtensionError::Package(format!("展開できません: {e}")))?;
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)?;
        // 宣言を信用せず、実際に出てきたバイト数を数える（上限 + 1 で打ち切る）
        let mut buf = [0u8; 64 * 1024];
        let mut written = 0u64;
        loop {
            let n = entry
                .by_ref()
                .take(MAX_FILE_BYTES + 1 - written.min(MAX_FILE_BYTES + 1))
                .read(&mut buf)
                .map_err(|e| ExtensionError::Package(format!("展開できません: {e}")))?;
            if n == 0 {
                break;
            }
            written += n as u64;
            total += n as u64;
            if written > MAX_FILE_BYTES {
                return refuse("ファイルが大きすぎます");
            }
            if total > MAX_TOTAL_BYTES {
                return refuse("展開後の合計が大きすぎます");
            }
            out.write_all(&buf[..n])?;
        }
        if written != item.declared {
            return refuse("宣言された大きさと、展開された大きさが違います");
        }
        if !wrote_first && crash == Some(CrashPoint::DuringExtract) {
            std::process::abort();
        }
        wrote_first = true;
    }
    Ok(())
}

/// 終端のレコード（EOCD）に書かれたエントリの数。
fn declared_entry_count(package: &Path) -> Option<usize> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(package).ok()?;
    let len = file.metadata().ok()?.len();
    let tail = len.min(22 + 65_535);
    file.seek(SeekFrom::Start(len - tail)).ok()?;
    let mut buf = vec![0u8; usize::try_from(tail).ok()?];
    file.read_exact(&mut buf).ok()?;
    let pos = buf
        .windows(4)
        .rposition(|w| w == [0x50, 0x4b, 0x05, 0x06])?;
    let count = buf.get(pos + 10..pos + 12)?;
    Some(usize::from(u16::from_le_bytes([count[0], count[1]])))
}
