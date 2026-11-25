//! 権限の同意の保存（`permissions.json`）と判定（research.md R7）。実行時の強制は 009 の範囲。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use unnotator_core::extensions_list::compare_versions;
use unnotator_core::fsio::{WriteStage, atomic_write};

use crate::error::ExtensionError;
use crate::registry::ExtensionEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PermissionVerdict {
    Allowed,
    /// 宣言していて、同意が無い。`warning` は、警告つきで確認すべきもの（`network`）。
    NeedsConsent {
        warning: bool,
    },
    /// 宣言していない。
    Denied,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPermission {
    pub permission: String,
    pub warning: bool,
}

fn needs_warning(permission: &str) -> bool {
    permission == "network"
}

pub struct ConsentStore {
    file: PathBuf,
    /// ID → 版 → 同意した権限。
    grants: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
    /// 知らないキー。そのまま保つ。
    extra: serde_json::Map<String, Value>,
}

impl ConsentStore {
    /// 開く。無ければ空。壊れていれば `.corrupt-<ms>` に退避して空で始める（すべて聞き直す）。
    pub fn open(file: &Path) -> Self {
        let mut store = Self {
            file: file.to_owned(),
            grants: BTreeMap::new(),
            extra: serde_json::Map::new(),
        };
        let Ok(text) = std::fs::read_to_string(file) else {
            return store;
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(mut map)) => {
                if let Some(grants) = map.remove("grants").and_then(|g| g.as_object().cloned()) {
                    for (id, versions) in grants {
                        for (version, record) in versions.as_object().cloned().unwrap_or_default() {
                            let granted: BTreeSet<String> = record["granted"]
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|v| v.as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default();
                            store
                                .grants
                                .entry(id.clone())
                                .or_default()
                                .insert(version, granted);
                        }
                    }
                }
                map.remove("version");
                store.extra = map;
            }
            _ => {
                let ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let name = file
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                if let Err(e) =
                    std::fs::rename(file, file.with_file_name(format!("{name}.corrupt-{ms}")))
                {
                    tracing::warn!("壊れた同意のファイルを退避できませんでした: {e}");
                }
            }
        }
        store
    }

    /// この版で、同意済みとみなす権限（その版の記録 + 最も新しい古い版の記録のうち、宣言されているもの）。
    fn effective(&self, entry: &ExtensionEntry) -> BTreeSet<String> {
        let declared: BTreeSet<&String> = entry.manifest.permissions.iter().collect();
        let Some(versions) = self.grants.get(&entry.id) else {
            return BTreeSet::new();
        };
        let mut out = BTreeSet::new();
        if let Some(own) = versions.get(&entry.version) {
            out.extend(own.iter().filter(|p| declared.contains(p)).cloned());
        }
        let previous = versions
            .keys()
            .filter(|v| compare_versions(v, &entry.version) == Some(std::cmp::Ordering::Less))
            .max_by(|a, b| compare_versions(a, b).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(previous) = previous {
            out.extend(
                versions[previous]
                    .iter()
                    .filter(|p| declared.contains(p))
                    .cloned(),
            );
        }
        out
    }

    pub fn check(&self, entry: &ExtensionEntry, permission: &str) -> PermissionVerdict {
        if !entry.manifest.permissions.iter().any(|p| p == permission) {
            return PermissionVerdict::Denied;
        }
        if self.effective(entry).contains(permission) {
            PermissionVerdict::Allowed
        } else {
            PermissionVerdict::NeedsConsent {
                warning: needs_warning(permission),
            }
        }
    }

    /// 宣言していて、まだ同意の無い権限。
    pub fn pending(&self, entry: &ExtensionEntry) -> Vec<PendingPermission> {
        let have = self.effective(entry);
        entry
            .manifest
            .permissions
            .iter()
            .filter(|p| !have.contains(*p))
            .map(|p| PendingPermission {
                permission: p.clone(),
                warning: needs_warning(p),
            })
            .collect()
    }

    pub fn grant(
        &mut self,
        entry: &ExtensionEntry,
        permissions: &[String],
    ) -> Result<(), ExtensionError> {
        self.grant_with_stop(entry, permissions, None)
    }

    #[doc(hidden)]
    pub fn grant_with_stop(
        &mut self,
        entry: &ExtensionEntry,
        permissions: &[String],
        stop: Option<WriteStage>,
    ) -> Result<(), ExtensionError> {
        for p in permissions {
            if !entry.manifest.permissions.contains(p) {
                return Err(ExtensionError::Invalid(format!(
                    "宣言していない権限には同意できません: {p}"
                )));
            }
        }
        let mut next = self.grants.clone();
        // 引き継いだ分も、この版の記録として残す
        let record = next
            .entry(entry.id.clone())
            .or_default()
            .entry(entry.version.clone())
            .or_default();
        record.extend(self.effective(entry));
        record.extend(permissions.iter().cloned());
        self.write(next, stop)
    }

    pub fn revoke(
        &mut self,
        id: &str,
        version: &str,
        permissions: &[String],
    ) -> Result<(), ExtensionError> {
        let mut next = self.grants.clone();
        if let Some(record) = next.get_mut(id).and_then(|v| v.get_mut(version)) {
            for p in permissions {
                record.remove(p);
            }
        }
        // 引き継ぎで戻らないように、古い版の記録からも外す
        if let Some(versions) = next.get_mut(id) {
            for record in versions.values_mut() {
                for p in permissions {
                    record.remove(p);
                }
            }
        }
        self.write(next, None)
    }

    /// 拡張機能を削除したとき、記録を消す（古い同意が新しい導入に流用されない）。
    pub fn forget(&mut self, id: &str) -> Result<(), ExtensionError> {
        let mut next = self.grants.clone();
        next.remove(id);
        self.write(next, None)
    }

    fn write(
        &mut self,
        next: BTreeMap<String, BTreeMap<String, BTreeSet<String>>>,
        stop: Option<WriteStage>,
    ) -> Result<(), ExtensionError> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut map = self.extra.clone();
        map.insert("version".to_owned(), json!(1));
        let grants: serde_json::Map<String, Value> = next
            .iter()
            .map(|(id, versions)| {
                let versions: serde_json::Map<String, Value> = versions
                    .iter()
                    .map(|(v, g)| (v.clone(), json!({ "granted": g, "at": at })))
                    .collect();
                (id.clone(), Value::Object(versions))
            })
            .collect();
        map.insert("grants".to_owned(), Value::Object(grants));
        atomic_write(
            &self.file,
            &serde_json::to_vec_pretty(&Value::Object(map))?,
            stop,
        )?;
        self.grants = next;
        Ok(())
    }
}
