//! `extensions-state.json`: 無効・固定した版・拡張子の上書き・開発者モード（data-model.md）。
//!
//! 利用者が手で書く `settings.json` とは別に、機械が書く運用の状態として持つ。
//! 知らないキーは保つ。書き込みは一時ファイル → 名前の置き換え。壊れていれば退避して既定値で始める。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};
use unnotator_core::extensions_list::compare_versions;
use unnotator_core::fsio::{WriteStage, atomic_write};

use crate::error::ExtensionError;
use crate::names::QualifiedId;

const FORMAT_VERSION: u64 = 1;
const KNOWN_KEYS: &[&str] = &[
    "version",
    "disabled",
    "pins",
    "mediaOverrides",
    "devMode",
    "devFolders",
];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExtensionsState {
    disabled: BTreeSet<String>,
    pins: BTreeMap<String, String>,
    media_overrides: BTreeMap<String, String>,
    dev_mode: bool,
    dev_folders: Vec<PathBuf>,
    /// 知らないキー（将来の版が書いたもの）。そのまま保つ。
    extra: Map<String, Value>,
}

impl ExtensionsState {
    /// 読み込む。ファイルが無ければ既定値。壊れていれば `.corrupt-<ms>` に退避して既定値。
    pub fn load(file: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(file) else {
            return Self::default();
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Self::from_map(map),
            _ => {
                quarantine(file);
                Self::default()
            }
        }
    }

    fn from_map(mut map: Map<String, Value>) -> Self {
        let strings = |v: Option<&Value>| -> Vec<String> {
            v.and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default()
        };
        let string_map = |v: Option<&Value>| -> BTreeMap<String, String> {
            v.and_then(Value::as_object)
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                        .collect()
                })
                .unwrap_or_default()
        };
        let state = Self {
            disabled: strings(map.get("disabled")).into_iter().collect(),
            pins: string_map(map.get("pins")),
            media_overrides: string_map(map.get("mediaOverrides")),
            dev_mode: map.get("devMode").and_then(Value::as_bool).unwrap_or(false),
            dev_folders: strings(map.get("devFolders"))
                .into_iter()
                .map(PathBuf::from)
                .collect(),
            extra: Map::new(),
        };
        for key in KNOWN_KEYS {
            map.remove(*key);
        }
        Self {
            extra: map,
            ..state
        }
    }

    fn to_value(&self) -> Value {
        let mut map = self.extra.clone();
        map.insert("version".to_owned(), json!(FORMAT_VERSION));
        map.insert("disabled".to_owned(), json!(self.disabled));
        map.insert("pins".to_owned(), json!(self.pins));
        map.insert("mediaOverrides".to_owned(), json!(self.media_overrides));
        map.insert("devMode".to_owned(), json!(self.dev_mode));
        map.insert(
            "devFolders".to_owned(),
            json!(
                self.dev_folders
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            ),
        );
        Value::Object(map)
    }

    pub fn save(&self, file: &Path) -> Result<(), ExtensionError> {
        self.save_with_stop(file, None)
    }

    /// `stop` の段階の直後で書き込みを打ち切る（テスト用）。
    #[doc(hidden)]
    pub fn save_with_stop(
        &self,
        file: &Path,
        stop: Option<WriteStage>,
    ) -> Result<(), ExtensionError> {
        let bytes = serde_json::to_vec_pretty(&self.to_value())?;
        atomic_write(file, &bytes, stop)?;
        Ok(())
    }

    // ---- 読み取り ----

    pub fn disabled(&self) -> &BTreeSet<String> {
        &self.disabled
    }

    pub fn pins(&self) -> &BTreeMap<String, String> {
        &self.pins
    }

    pub fn media_overrides(&self) -> &BTreeMap<String, String> {
        &self.media_overrides
    }

    pub fn dev_mode(&self) -> bool {
        self.dev_mode
    }

    /// 記録している開発中のフォルダ（開発者モードがオフでも返す）。
    pub fn dev_folders(&self) -> Vec<PathBuf> {
        self.dev_folders.clone()
    }

    /// 読み込み対象のフォルダ。開発者モードがオフなら空。
    pub fn active_dev_folders(&self) -> Vec<PathBuf> {
        if self.dev_mode {
            self.dev_folders.clone()
        } else {
            Vec::new()
        }
    }

    // ---- 変更（メモリ上。`save` で書く） ----

    pub fn set_disabled(&mut self, id: &str, disabled: bool) {
        if disabled {
            self.disabled.insert(id.to_owned());
        } else {
            self.disabled.remove(id);
        }
    }

    /// 使う版を固定する。`None` で解除。版は `x.y.z` の形でなければならない。
    pub fn pin(&mut self, id: &str, version: Option<&str>) -> Result<(), ExtensionError> {
        match version {
            None => {
                self.pins.remove(id);
            }
            Some(v) => {
                if compare_versions(v, v).is_none() {
                    return Err(ExtensionError::Invalid(format!("版を読めません: {v:?}")));
                }
                self.pins.insert(id.to_owned(), v.to_owned());
            }
        }
        Ok(())
    }

    /// 拡張子（`txt`・`.TXT` どちらでも可）→ 完全な媒体種別 ID の上書き。`None` で解除。
    pub fn set_media_override(
        &mut self,
        extension: &str,
        media_type: Option<&str>,
    ) -> Result<(), ExtensionError> {
        let ext = normalize_extension(extension)?;
        match media_type {
            None => {
                self.media_overrides.remove(&ext);
            }
            Some(id) => {
                if QualifiedId::parse(id).is_none() {
                    return Err(ExtensionError::Invalid(format!(
                        "媒体種別 ID は `<拡張機能の ID>/<名前>` の形でなければなりません: {id:?}"
                    )));
                }
                self.media_overrides.insert(ext, id.to_owned());
            }
        }
        Ok(())
    }

    pub fn set_dev_mode(&mut self, on: bool) {
        self.dev_mode = on;
    }

    pub fn add_dev_folder(&mut self, folder: PathBuf) {
        if !self.dev_folders.contains(&folder) {
            self.dev_folders.push(folder);
        }
    }

    pub fn remove_dev_folder(&mut self, folder: &Path) {
        self.dev_folders.retain(|f| f != folder);
    }
}

fn normalize_extension(raw: &str) -> Result<String, ExtensionError> {
    let lower = raw.trim().to_lowercase();
    let body = lower.trim_start_matches('.');
    let ok = !body.is_empty()
        && body.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-'
        });
    if ok {
        Ok(format!(".{body}"))
    } else {
        Err(ExtensionError::Invalid(format!(
            "拡張子として使えません: {raw:?}"
        )))
    }
}

/// 壊れたファイルを、同じ場所に `.corrupt-<ms>` として退避する（上書きして失わないため）。
fn quarantine(file: &Path) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = file.with_file_name(format!("{name}.corrupt-{ms}"));
    if let Err(e) = std::fs::rename(file, &target) {
        tracing::warn!("壊れた状態ファイルを退避できませんでした: {e}");
    }
}
