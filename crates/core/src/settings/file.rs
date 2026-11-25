//! 設定ファイル（平らな JSON オブジェクト）の読み書き。
//!
//! 知らないキーは保つ。壊れたファイルは上書きせず警告にし、書き込みが必要になったときに別名へ退避する。
//! 書き込みは一時ファイル → 置き換え（`fsio::atomic_write`）。キーは名前順で書く（差分が安定する）。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::error::StoreError;
use crate::fsio::{WriteStage, atomic_write};
use crate::recovery::hash::sha256_hex;

pub type SettingsMap = Map<String, Value>;

/// 設定ファイルを読めなかった理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsWarning {
    pub path: PathBuf,
    pub why: String,
}

#[derive(Debug, Clone)]
pub struct Loaded {
    pub map: SettingsMap,
    /// ファイルが壊れていた（JSON でない・オブジェクトでない・読めない）ときの理由。
    pub warning: Option<SettingsWarning>,
    /// 読んだ内容のハッシュ（ファイルが無いときは `None`）。自分の書き込みの見分けに使う。
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SettingsFile {
    path: PathBuf,
}

impl SettingsFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 読む。無ければ空。壊れていれば空と警告（ファイルには触れない）。
    pub fn load(&self) -> Loaded {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Loaded {
                    map: SettingsMap::new(),
                    warning: None,
                    content_hash: None,
                };
            }
            Err(error) => return self.broken(None, error.to_string()),
        };
        let hash = sha256_hex(&bytes);
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(map)) => Loaded {
                map,
                warning: None,
                content_hash: Some(hash),
            },
            Ok(_) => self.broken(
                Some(hash),
                "最上位が JSON のオブジェクトではありません".to_owned(),
            ),
            Err(error) => self.broken(Some(hash), error.to_string()),
        }
    }

    fn broken(&self, content_hash: Option<String>, why: String) -> Loaded {
        Loaded {
            map: SettingsMap::new(),
            warning: Some(SettingsWarning {
                path: self.path.clone(),
                why,
            }),
            content_hash,
        }
    }

    /// 書く。壊れたファイルが既にあるときは、先に `settings.json.corrupt-<時刻>` へ退避する。戻り値は書いた内容のハッシュ。
    pub fn write(&self, map: &SettingsMap, now_ms: i64) -> Result<String, StoreError> {
        self.write_staged(map, now_ms, None)
    }

    #[doc(hidden)]
    pub fn write_with_stop(
        &self,
        map: &SettingsMap,
        now_ms: i64,
        stage: WriteStage,
    ) -> Result<String, StoreError> {
        self.write_staged(map, now_ms, Some(stage))
    }

    fn write_staged(
        &self,
        map: &SettingsMap,
        now_ms: i64,
        stop: Option<WriteStage>,
    ) -> Result<String, StoreError> {
        if self.load().warning.is_some() && self.path.exists() {
            self.quarantine(now_ms)?;
        }
        let mut text = serde_json::to_string_pretty(map)
            .map_err(|error| StoreError::InvalidCommand(error.to_string()))?;
        text.push('\n');
        atomic_write(&self.path, text.as_bytes(), stop)?;
        Ok(sha256_hex(text.as_bytes()))
    }

    fn quarantine(&self, now_ms: i64) -> Result<(), StoreError> {
        let name = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "settings.json".to_owned());
        let target = self.path.with_file_name(format!("{name}.corrupt-{now_ms}"));
        std::fs::rename(&self.path, target)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let dir =
                std::env::temp_dir().join(format!("unno-settings-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self) -> SettingsFile {
            SettingsFile::new(self.0.join("settings.json"))
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn map(value: Value) -> SettingsMap {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn missing_file_is_empty_without_warning() {
        let tmp = Tmp::new("missing");
        let loaded = tmp.file().load();
        assert!(loaded.map.is_empty() && loaded.warning.is_none() && loaded.content_hash.is_none());
    }

    #[test]
    fn unknown_keys_survive_load_modify_write() {
        let tmp = Tmp::new("unknown");
        let file = tmp.file();
        std::fs::write(
            file.path(),
            r#"{"com.example.zoom": {"fit": true}, "assets.watch": true, "future.key": [1,2]}"#,
        )
        .unwrap();
        let mut loaded = file.load();
        loaded.map.insert("assets.watch".into(), json!(false));
        file.write(&loaded.map, 1).unwrap();
        let again = file.load();
        assert_eq!(again.map["assets.watch"], json!(false));
        assert_eq!(again.map["com.example.zoom"], json!({"fit": true}));
        assert_eq!(again.map["future.key"], json!([1, 2]));
        assert!(again.warning.is_none());
    }

    #[test]
    fn keys_are_written_in_name_order_with_a_trailing_newline() {
        let tmp = Tmp::new("order");
        let file = tmp.file();
        file.write(&map(json!({"b": 1, "a": 2})), 1).unwrap();
        let text = std::fs::read_to_string(file.path()).unwrap();
        assert!(text.ends_with("}\n"));
        assert!(text.find("\"a\"").unwrap() < text.find("\"b\"").unwrap());
    }

    #[test]
    fn broken_file_is_not_touched_by_load_and_is_quarantined_on_write() {
        let tmp = Tmp::new("broken");
        let file = tmp.file();
        std::fs::write(file.path(), "{ not json").unwrap();
        let loaded = file.load();
        assert!(loaded.map.is_empty());
        assert!(loaded.warning.is_some());
        assert_eq!(std::fs::read_to_string(file.path()).unwrap(), "{ not json");

        file.write(&map(json!({"a": 1})), 42).unwrap();
        assert_eq!(
            std::fs::read_to_string(tmp.0.join("settings.json.corrupt-42")).unwrap(),
            "{ not json"
        );
        assert_eq!(file.load().map["a"], json!(1));
    }

    #[test]
    fn non_object_top_level_is_a_warning() {
        let tmp = Tmp::new("array");
        let file = tmp.file();
        std::fs::write(file.path(), "[1,2]").unwrap();
        assert!(file.load().warning.is_some());
    }

    #[test]
    fn stopping_midway_leaves_the_old_or_the_new_complete_content() {
        for stage in [
            WriteStage::AfterWrite,
            WriteStage::AfterSync,
            WriteStage::AfterRename,
        ] {
            let tmp = Tmp::new(&format!("stop-{stage:?}"));
            let file = tmp.file();
            file.write(&map(json!({"v": "old"})), 1).unwrap();
            let result = file.write_with_stop(&map(json!({"v": "new"})), 2, stage);
            assert!(matches!(result, Err(StoreError::Aborted)));
            let loaded = file.load();
            assert!(loaded.warning.is_none(), "{stage:?}");
            let value = loaded.map["v"].as_str().unwrap().to_owned();
            let expected = if stage == WriteStage::AfterRename {
                "new"
            } else {
                "old"
            };
            assert_eq!(value, expected, "{stage:?}");
        }
    }

    #[test]
    fn write_returns_the_hash_that_a_later_load_reports() {
        let tmp = Tmp::new("hash");
        let file = tmp.file();
        let written = file.write(&map(json!({"a": 1})), 1).unwrap();
        assert_eq!(file.load().content_hash, Some(written));
    }
}
