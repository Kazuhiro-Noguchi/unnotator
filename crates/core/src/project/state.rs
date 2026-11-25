//! 未保存の状態（data-model.md「未保存の状態」）。

use serde::{Deserialize, Serialize};

/// 開いているプロジェクトの、未保存の状態。画面が●を切り替えるのに使う。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
pub struct SaveState {
    /// `unsaved_count > 0`
    pub dirty: bool,
    /// `journal.db` の `entries` の件数（Undo / Redo も 1 件として数える）。
    pub unsaved_count: u32,
    /// 最後に編集が確定した時刻（ミリ秒）。未保存が無ければ `None`。
    /// 画面側では `number`（ミリ秒の時刻は 2^53 未満で、欠けない）。
    #[cfg_attr(feature = "specta", specta(type = Option<f64>))]
    pub last_change_at: Option<i64>,
    /// 保存の実行中か。
    pub saving: bool,
}

impl SaveState {
    pub fn new(unsaved_count: u32, last_change_at: Option<i64>, saving: bool) -> Self {
        Self {
            dirty: unsaved_count > 0,
            unsaved_count,
            last_change_at,
            saving,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_follows_the_count() {
        assert!(!SaveState::new(0, None, false).dirty);
        assert!(SaveState::new(1, Some(5), false).dirty);
        let saving = SaveState::new(3, Some(5), true);
        assert!(saving.dirty && saving.saving);
    }

    #[test]
    fn serializes_with_stable_field_names() {
        let json = serde_json::to_value(SaveState::new(2, Some(7), false)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"dirty": true, "unsaved_count": 2, "last_change_at": 7, "saving": false})
        );
    }
}
