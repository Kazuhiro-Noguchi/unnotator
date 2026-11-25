//! 設定（ユーザーとプロジェクトの 2 段）。DB の外のファイルで、`apply_command` を通さない（憲章 III の対象はプロジェクトのデータ）。
//!
//! 実効値は、プロジェクト → ユーザー → 既定値の順で決まる。変更はすぐファイルへ書かれ、Undo にも未保存の件数にも入らない。

pub mod file;
pub mod keys;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::clock::{Clock, SystemClock};
use crate::error::StoreError;
use crate::fsio::WriteStage;
use file::{SettingsFile, SettingsMap};

pub use file::SettingsWarning as FileWarning;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Layer {
    User,
    Project,
}

impl Layer {
    fn name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Project => "project",
        }
    }
}

/// 実効値が、どの段のものか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub enum Source {
    Project,
    User,
    Default,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Effective {
    pub value: Value,
    pub source: Source,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SettingsChanged {
    pub layer: Layer,
    pub keys: Vec<String>,
}

/// 読めなかった・使えなかった理由（壊れたファイル・検証に合わない値）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SettingsIssue {
    pub layer: Layer,
    pub why: String,
}

type Subscriber = Box<dyn Fn(&SettingsChanged) + Send>;

struct LayerState {
    file: SettingsFile,
    map: SettingsMap,
    /// 最後に読んだ・書いた内容のハッシュ（自分の書き込みの見分けに使う）。
    hash: Option<String>,
    writable: bool,
    broken: Option<String>,
}

impl LayerState {
    fn load(path: PathBuf, writable: bool) -> Self {
        let file = SettingsFile::new(path);
        let loaded = file.load();
        Self {
            file,
            map: loaded.map,
            hash: loaded.content_hash,
            writable,
            broken: loaded.warning.map(|w| w.why),
        }
    }
}

pub struct Settings {
    user: Option<LayerState>,
    project: Option<LayerState>,
    subscribers: Vec<Subscriber>,
    clock: Box<dyn Clock>,
}

impl std::fmt::Debug for Settings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Settings").finish_non_exhaustive()
    }
}

impl Settings {
    /// `user`: ユーザー設定のファイル。`project`: プロジェクト設定のファイルと、書き込めるか（ロックを持っているか）。
    pub fn new(user: Option<PathBuf>, project: Option<(PathBuf, bool)>) -> Self {
        Self {
            user: user.map(|path| LayerState::load(path, true)),
            project: project.map(|(path, writable)| LayerState::load(path, writable)),
            subscribers: Vec::new(),
            clock: Box::new(SystemClock),
        }
    }

    /// プロジェクトを開いていなくても使える、ユーザー設定だけの窓口。`dir` は設定のフォルダ。
    pub fn open_user(dir: &Path) -> Self {
        Self::new(Some(dir.join("settings.json")), None)
    }

    /// ユーザー設定のフォルダを後から付ける（既に付いていれば読み直す）。
    pub fn attach_user(&mut self, dir: &Path) {
        self.user = Some(LayerState::load(dir.join("settings.json"), true));
    }

    pub fn subscribe(&mut self, subscriber: Subscriber) {
        self.subscribers.push(subscriber);
    }

    fn state(&self, layer: Layer) -> Result<&LayerState, StoreError> {
        match layer {
            Layer::User => self.user.as_ref(),
            Layer::Project => self.project.as_ref(),
        }
        .ok_or(StoreError::NotOpen)
    }

    fn state_mut(&mut self, layer: Layer) -> Result<&mut LayerState, StoreError> {
        match layer {
            Layer::User => self.user.as_mut(),
            Layer::Project => self.project.as_mut(),
        }
        .ok_or(StoreError::NotOpen)
    }

    /// 段の生の内容。
    pub fn layer(&self, layer: Layer) -> Option<&SettingsMap> {
        match layer {
            Layer::User => self.user.as_ref(),
            Layer::Project => self.project.as_ref(),
        }
        .map(|state| &state.map)
    }

    /// 実効値。段の値が検証に合わないときは、その段を飛ばして下の段を使う。
    pub fn effective(&self, key: &str) -> Result<Effective, StoreError> {
        for (layer, source) in [
            (Layer::Project, Source::Project),
            (Layer::User, Source::User),
        ] {
            let Some(value) = self.layer(layer).and_then(|map| map.get(key)) else {
                continue;
            };
            if keys::core_key(key).is_some() && keys::validate(key, value).is_err() {
                continue;
            }
            return Ok(Effective {
                value: value.clone(),
                source,
            });
        }
        Ok(Effective {
            value: keys::default_value(key).unwrap_or(Value::Null),
            source: Source::Default,
        })
    }

    /// 壊れたファイルと、検証に合わない値。
    pub fn warnings(&self) -> Vec<SettingsIssue> {
        let mut issues = Vec::new();
        for layer in [Layer::Project, Layer::User] {
            let Ok(state) = self.state(layer) else {
                continue;
            };
            if let Some(why) = &state.broken {
                issues.push(SettingsIssue {
                    layer,
                    why: format!("設定ファイルを読めない: {why}"),
                });
            }
            for (key, value) in &state.map {
                if keys::core_key(key).is_some()
                    && let Err(why) = keys::validate(key, value)
                {
                    issues.push(SettingsIssue {
                        layer,
                        why: format!("{key}: {why}（この値は使わない）"),
                    });
                }
            }
        }
        issues
    }

    pub fn set(&mut self, layer: Layer, key: &str, value: Value) -> Result<(), StoreError> {
        self.write_key(layer, key, Some(value), None)
    }

    pub fn unset(&mut self, layer: Layer, key: &str) -> Result<(), StoreError> {
        self.write_key(layer, key, None, None)
    }

    /// 書き込みの途中で打ち切る（テスト用）。
    #[doc(hidden)]
    pub fn set_with_stop(
        &mut self,
        layer: Layer,
        key: &str,
        value: Value,
        stage: WriteStage,
    ) -> Result<(), StoreError> {
        self.write_key(layer, key, Some(value), Some(stage))
    }

    fn write_key(
        &mut self,
        layer: Layer,
        key: &str,
        value: Option<Value>,
        stop: Option<WriteStage>,
    ) -> Result<(), StoreError> {
        if let Some(value) = &value {
            keys::validate(key, value).map_err(|why| StoreError::InvalidSetting {
                key: key.to_owned(),
                why,
            })?;
        }
        let now = self.clock.now_ms();
        let state = self.state_mut(layer)?;
        if !state.writable {
            return Err(StoreError::ReadOnly);
        }
        let mut map = state.map.clone();
        match value {
            Some(value) => {
                map.insert(key.to_owned(), value);
            }
            None => {
                if map.remove(key).is_none() {
                    return Ok(()); // 無い値を消しても、何も書かない
                }
            }
        }
        let hash = match stop {
            Some(stage) => state.file.write_with_stop(&map, now, stage)?,
            None => state.file.write(&map, now)?,
        };
        state.map = map;
        state.hash = Some(hash);
        state.broken = None;
        self.notify(&SettingsChanged {
            layer,
            keys: vec![key.to_owned()],
        });
        Ok(())
    }

    /// ファイルを読み直す。外から変わっていたら反映して通知し、変わったキーを返す。自分の書き込みは変化として数えない。
    pub fn reload(&mut self) -> Result<Vec<String>, StoreError> {
        let mut all = BTreeSet::new();
        for layer in [Layer::Project, Layer::User] {
            let Ok(state) = self.state_mut(layer) else {
                continue;
            };
            let loaded = state.file.load();
            let broken = loaded.warning.map(|w| w.why);
            if loaded.content_hash == state.hash && broken == state.broken {
                continue;
            }
            let mut changed = BTreeSet::new();
            for key in state.map.keys().chain(loaded.map.keys()) {
                if state.map.get(key) != loaded.map.get(key) {
                    changed.insert(key.clone());
                }
            }
            state.map = loaded.map;
            state.hash = loaded.content_hash;
            state.broken = broken;
            if !changed.is_empty() {
                let keys: Vec<String> = changed.iter().cloned().collect();
                all.extend(changed);
                self.notify(&SettingsChanged { layer, keys });
            }
        }
        Ok(all.into_iter().collect())
    }

    fn notify(&self, changed: &SettingsChanged) {
        for subscriber in &self.subscribers {
            subscriber(changed);
        }
    }

    /// 段の名前（ログ・エラー用）。
    pub fn layer_name(layer: Layer) -> &'static str {
        layer.name()
    }
}
