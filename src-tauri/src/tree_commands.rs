//! アセットツリーの IPC コマンド（specs/007-tree-preview/contracts/ipc.md）。
//! 索引と見え方の保持、型の変換だけを行う薄い層。並び・集計・窓の取得は `unnotator-core`。

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use specta::Type;
use unnotator_core::assets::tree::{FlatView, Located, TreeIndex, TreeRow, ViewSpec};
use unnotator_core::event::ChangeSet;

use crate::project_commands::{IpcError, ProjectState, with_store};

/// 保持している見え方。`version` は呼び出しごとに進み、古い窓の取得を拒むために使う。
struct ViewSlot {
    version: u32,
    flat: FlatView,
}

/// 索引と見え方。ロックの順序は、プロジェクトの状態 → ここ（同じ向きだけ）。
#[derive(Default)]
pub struct TreeState {
    index: Option<TreeIndex>,
    view: Option<ViewSlot>,
    counter: u32,
}

pub type SharedTree = Arc<Mutex<TreeState>>;

impl TreeState {
    /// プロジェクトを開く・復元するときに、前の索引を捨てる。
    pub(crate) fn reset(&mut self) {
        self.index = None;
        self.view = None;
    }

    /// 変更の差分を受け取る（コミットの後に呼ばれる）。
    pub(crate) fn note(&mut self, set: &ChangeSet) {
        if let Some(index) = self.index.as_mut() {
            index.note_changes(set);
        }
    }

    fn fresh<'a>(
        &'a mut self,
        source: &dyn unnotator_core::assets::tree::AssetSource,
    ) -> Result<&'a mut TreeIndex, unnotator_core::error::StoreError> {
        match self.index.as_mut() {
            Some(index) => index.refresh(source)?,
            None => self.index = Some(TreeIndex::build(source.all_assets()?)),
        }
        // 直前の分岐で必ず `Some` になる。
        self.index
            .as_mut()
            .ok_or(unnotator_core::error::StoreError::NotOpen)
    }
}

/// 別の処理が異常終了してロックが汚れていても、索引を捨てて続ける（索引は DB から作り直せる）。
fn lock(tree: &SharedTree) -> MutexGuard<'_, TreeState> {
    tree.lock().unwrap_or_else(|poisoned| {
        let mut guard = poisoned.into_inner();
        guard.reset();
        guard
    })
}

/// `tree_view_set` の結果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ViewInfo {
    /// 窓の取得に渡す版。
    pub version: u32,
    /// 見える行の総数。
    pub total: u32,
    /// 索引の世代（作り直しのたびに進む）。
    pub generation: u32,
}

/// 窓。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TreeWindow {
    pub version: u32,
    pub total: u32,
    pub offset: u32,
    pub rows: Vec<TreeRow>,
}

/// 索引を最新にする（差分の反映・必要なら作り直し）。プロジェクトのロックを持っている間だけ呼ぶ。
fn refresh(state: &ProjectState) -> Result<SharedTree, IpcError> {
    let tree = state.tree();
    with_store(state, |store| {
        lock(&tree).fresh(store)?;
        Ok(())
    })?;
    Ok(tree)
}

/// 見え方を保存して、行の総数を返す。索引が古ければ先に整える。
pub fn view_set(state: &ProjectState, spec: &ViewSpec) -> Result<ViewInfo, IpcError> {
    let tree = refresh(state)?;
    let mut guard = lock(&tree);
    let Some(index) = guard.index.as_ref() else {
        return Err(IpcError::stale_view());
    };
    let flat = index.flatten(spec);
    let (total, generation) = (flat.total(), index.generation());
    guard.counter = guard.counter.wrapping_add(1);
    let version = guard.counter;
    guard.view = Some(ViewSlot { version, flat });
    Ok(ViewInfo {
        version,
        total,
        generation: u32::try_from(generation).unwrap_or(u32::MAX),
    })
}

/// 見え方の版が合っているときだけ、`f` に渡す。
fn with_view<T>(
    state: &ProjectState,
    version: u32,
    f: impl FnOnce(&TreeIndex, &FlatView) -> Option<T>,
) -> Result<T, IpcError> {
    let tree = refresh(state)?;
    let guard = lock(&tree);
    let (Some(index), Some(slot)) = (guard.index.as_ref(), guard.view.as_ref()) else {
        return Err(IpcError::stale_view());
    };
    if slot.version != version {
        return Err(IpcError::stale_view());
    }
    f(index, &slot.flat).ok_or_else(IpcError::stale_view)
}

/// 窓を返す。版が古い（見え方を変えた・索引が作り直された）ときは `stale_view`。
pub fn rows(
    state: &ProjectState,
    version: u32,
    offset: u32,
    limit: u32,
) -> Result<TreeWindow, IpcError> {
    with_view(state, version, |index, flat| {
        let rows = flat.window(index, offset, limit)?;
        Some(TreeWindow {
            version,
            total: flat.total(),
            offset,
            rows,
        })
    })
}

/// アセットの行の位置と、開くべき祖先。知らないアセットは `None`。
pub fn locate(
    state: &ProjectState,
    version: u32,
    asset_id: &str,
) -> Result<Option<Located>, IpcError> {
    with_view(state, version, |index, flat| {
        Some(flat.locate(index, asset_id))
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn tree_view_set(
    state: tauri::State<'_, ProjectState>,
    spec: ViewSpec,
) -> Result<ViewInfo, IpcError> {
    view_set(&state, &spec)
}

#[tauri::command(async)]
#[specta::specta]
pub fn tree_rows(
    state: tauri::State<'_, ProjectState>,
    version: u32,
    offset: u32,
    limit: u32,
) -> Result<TreeWindow, IpcError> {
    rows(&state, version, offset, limit)
}

#[tauri::command(async)]
#[specta::specta]
pub fn tree_locate(
    state: tauri::State<'_, ProjectState>,
    version: u32,
    asset_id: String,
) -> Result<Option<Located>, IpcError> {
    locate(&state, version, &asset_id)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;
    use crate::asset_commands::{list, scan};
    use crate::project_commands::{CloseChoice, Hooks, apply, open_project, undo_project};
    use unnotator_core::assets::scan::ScanScope;
    use unnotator_core::assets::tree::NodeKey;
    use unnotator_core::assets::{AssetFilter, Page};
    use unnotator_core::command::{Command, Status};

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "unnotator-tree-ipc-{}-{}-{n}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(path.join("project/d")).expect("一時フォルダを作れる");
            Self(path)
        }
        fn project(&self) -> std::path::PathBuf {
            self.0.join("project")
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open_with_files(temp: &Temp, files: &[&str]) -> ProjectState {
        for f in files {
            std::fs::write(temp.project().join(f), b"x").expect("書ける");
        }
        let state = ProjectState::new(temp.0.join("recovery"));
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        state
    }

    fn open_all() -> ViewSpec {
        ViewSpec {
            expanded_folders: HashSet::from([
                NodeKey {
                    root_key: String::new(),
                    path: String::new(),
                },
                NodeKey {
                    root_key: String::new(),
                    path: "d".to_owned(),
                },
            ]),
            ..ViewSpec::default()
        }
    }

    #[test]
    fn nothing_is_available_while_no_project_is_open() {
        let temp = Temp::new();
        let state = ProjectState::new(temp.0.join("recovery"));
        assert_eq!(
            view_set(&state, &ViewSpec::default()).unwrap_err().code,
            "not_open"
        );
        assert_eq!(rows(&state, 1, 0, 5).unwrap_err().code, "not_open");
        assert_eq!(locate(&state, 1, "x").unwrap_err().code, "not_open");
    }

    #[test]
    fn view_rows_and_locate_work_on_an_open_project() {
        let temp = Temp::new();
        let state = open_with_files(&temp, &["b.txt", "d/a.txt"]);
        let info = view_set(&state, &open_all()).expect("見え方を保存できる");
        assert_eq!(info.total, 4); // ルート・d・a.txt・b.txt
        let window = rows(&state, info.version, 0, 10).expect("窓");
        assert_eq!(window.rows.len(), 4);
        assert!(matches!(window.rows[0], TreeRow::Root { total: 2, .. }));
        let id = list(&state, &AssetFilter::default(), &Page::first(10))
            .expect("一覧")
            .items
            .iter()
            .find(|a| a.rel_path == "d/a.txt")
            .expect("ある")
            .id
            .clone();
        let located = locate(&state, info.version, &id)
            .expect("位置")
            .expect("知っている");
        assert_eq!(located.row, Some(2));
    }

    #[test]
    fn an_old_version_is_stale_and_a_new_view_replaces_it() {
        let temp = Temp::new();
        let state = open_with_files(&temp, &["b.txt"]);
        let first = view_set(&state, &ViewSpec::default()).expect("保存");
        let second = view_set(&state, &open_all()).expect("保存");
        assert_ne!(second.version, first.version);
        assert_eq!(
            rows(&state, first.version, 0, 5).unwrap_err().code,
            "stale_view"
        );
        assert!(rows(&state, second.version, 0, 5).is_ok());
    }

    #[test]
    fn a_status_change_and_its_undo_show_up_without_a_rebuild() {
        let temp = Temp::new();
        let state = open_with_files(&temp, &["b.txt", "d/a.txt"]);
        let info = view_set(&state, &open_all()).expect("保存");
        let id = list(&state, &AssetFilter::default(), &Page::first(10))
            .expect("一覧")
            .items
            .iter()
            .find(|a| a.rel_path == "d/a.txt")
            .expect("ある")
            .id
            .clone();
        apply(
            &state,
            Command::SetAssetStatus {
                asset_id: id.clone(),
                status: Status::Done,
            },
        )
        .expect("適用できる");
        let window = rows(&state, info.version, 0, 10).expect("版は有効のまま");
        assert!(matches!(window.rows[1], TreeRow::Folder { done: 1, .. }));
        assert!(matches!(
            window.rows[2],
            TreeRow::Asset {
                status: Status::Done,
                ..
            }
        ));
        undo_project(&state).expect("戻せる");
        let window = rows(&state, info.version, 0, 10).expect("版は有効のまま");
        assert!(matches!(window.rows[1], TreeRow::Folder { done: 0, .. }));
    }

    #[test]
    fn a_scan_that_adds_files_makes_the_old_version_stale() {
        let temp = Temp::new();
        let state = open_with_files(&temp, &["b.txt"]);
        let info = view_set(&state, &open_all()).expect("保存");
        std::fs::write(temp.project().join("c.txt"), b"x").expect("書ける");
        scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        assert_eq!(
            rows(&state, info.version, 0, 5).unwrap_err().code,
            "stale_view"
        );
        let again = view_set(&state, &open_all()).expect("保存し直せる");
        assert!(again.total > info.total);
        assert!(again.generation > info.generation);
    }

    #[test]
    fn opening_another_project_drops_the_previous_index() {
        let first = Temp::new();
        let state = open_with_files(&first, &["b.txt"]);
        let info = view_set(&state, &ViewSpec::default()).expect("保存");
        crate::project_commands::close_project(&state, Some(CloseChoice::Discard))
            .expect("閉じられる");
        let second = Temp::new();
        std::fs::write(second.project().join("z.txt"), b"x").expect("書ける");
        open_project(&state, &second.project(), true, Hooks::default()).expect("作れる");
        assert_eq!(
            rows(&state, info.version, 0, 5).unwrap_err().code,
            "stale_view"
        );
    }
}
