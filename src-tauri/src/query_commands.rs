//! 読み取りの IPC（008）。DB を変えない。形は `specs/008-properties-labels/contracts/ipc-queries.md`。
//!
//! 位置の指定（selector）は返さない。書き込みは `apply_command` だけ。

use unnotator_core::query::labels::LabelRow;
use unnotator_core::query::page::{AnnotationCursor, AnnotationPage};
use unnotator_core::query::schemas::SchemaRow;
use unnotator_core::query::target::TargetDetails;

use crate::project_commands::{IpcError, ProjectState, with_store};

pub fn labels(state: &ProjectState) -> Result<Vec<LabelRow>, IpcError> {
    with_store(state, |store| store.list_labels())
}

pub fn schemas(state: &ProjectState) -> Result<Vec<SchemaRow>, IpcError> {
    with_store(state, |store| store.list_schemas())
}

/// アセットが無いときは `missing`。
pub fn details(
    state: &ProjectState,
    asset_id: &str,
    item_key: Option<&str>,
) -> Result<TargetDetails, IpcError> {
    with_store(state, |store| store.target_details(asset_id, item_key))?
        .ok_or_else(|| IpcError::missing(asset_id))
}

pub fn page(
    state: &ProjectState,
    asset_id: &str,
    item_key: Option<&str>,
    cursor: Option<&AnnotationCursor>,
) -> Result<AnnotationPage, IpcError> {
    with_store(state, |store| {
        store.annotations_page(asset_id, item_key, cursor)
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn labels_list(state: tauri::State<'_, ProjectState>) -> Result<Vec<LabelRow>, IpcError> {
    labels(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn schemas_list(state: tauri::State<'_, ProjectState>) -> Result<Vec<SchemaRow>, IpcError> {
    schemas(&state)
}

#[tauri::command(async)]
#[specta::specta]
pub fn target_details(
    state: tauri::State<'_, ProjectState>,
    asset_id: String,
    item_key: Option<String>,
) -> Result<TargetDetails, IpcError> {
    details(&state, &asset_id, item_key.as_deref())
}

#[tauri::command(async)]
#[specta::specta]
pub fn annotations_page(
    state: tauri::State<'_, ProjectState>,
    asset_id: String,
    item_key: Option<String>,
    cursor: Option<AnnotationCursor>,
) -> Result<AnnotationPage, IpcError> {
    page(&state, &asset_id, item_key.as_deref(), cursor.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_readable_while_no_project_is_open() {
        let state = ProjectState::new(std::env::temp_dir().join("unno-query-test"));
        assert!(labels(&state).is_err());
        assert!(schemas(&state).is_err());
        assert!(details(&state, "a", None).is_err());
        assert!(page(&state, "a", None, None).is_err());
    }
}
