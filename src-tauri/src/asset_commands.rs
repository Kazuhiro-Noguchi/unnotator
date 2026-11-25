//! アセットの IPC コマンド（contracts/ipc.md）。状態の保持と型の変換だけを行う薄い層。
//! 走査・一覧・判定規則の中身は `unnotator-core` にある。

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use unnotator_core::assets::media::MediaRules;
use unnotator_core::assets::scan::{ScanProgress, ScanScope};
use unnotator_core::assets::{AssetFilter, AssetPage, Page};
use unnotator_core::project::assets::ScanSummary;

use crate::project_commands::{IpcError, ProjectState, with_store};

/// 一覧（カーソル方式）。
pub fn list(
    state: &ProjectState,
    filter: &AssetFilter,
    page: &Page,
) -> Result<AssetPage, IpcError> {
    with_store(state, |store| store.list_assets(filter, page))
}

/// 走査する。歩く間は、状態の `Mutex` を手放す（編集が待たされない）。
pub fn scan(
    state: &ProjectState,
    scope: ScanScope,
    progress: &dyn Fn(ScanProgress),
) -> Result<ScanSummary, IpcError> {
    state.scan_cancel().store(false, Ordering::SeqCst);
    let job = with_store(state, |store| store.begin_scan(scope))?;
    let report = job.run(state.scan_cancel(), progress);
    with_store(state, |store| store.apply_scan(report))
}

/// 走査を中断する。整合した部分の結果で終わる（リンク切れは出さない）。
pub fn cancel_scan(state: &ProjectState) {
    state.scan_cancel().store(true, Ordering::SeqCst);
}

/// 判定規則を設定して、既存のアセットへ反映する。変えた件数を返す。
pub fn set_rules(state: &ProjectState, rules: MediaRules) -> Result<u32, IpcError> {
    with_store(state, |store| {
        store.set_media_rules(rules);
        store.reclassify_assets()
    })
}

/// 走査の進み具合の通知。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ScanProgressEvent(pub ScanProgress);

/// アセットの変化の通知（件数にまとめる）。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct AssetsChanged {
    pub added: u32,
    pub updated: u32,
    pub went_missing: u32,
    pub restored: u32,
    pub reclassified: u32,
    /// `sync` / `relink` / `delete`
    pub origin: String,
}

impl AssetsChanged {
    /// 走査の要約から作る。何も変わらなければ `None`（通知しない）。
    pub fn from_summary(summary: &ScanSummary) -> Option<Self> {
        let changed = summary.added
            + summary.updated
            + summary.went_missing
            + summary.restored
            + summary.reclassified;
        (changed > 0).then(|| Self {
            added: summary.added,
            updated: summary.updated,
            went_missing: summary.went_missing,
            restored: summary.restored,
            reclassified: summary.reclassified,
            origin: "sync".to_owned(),
        })
    }
}

/// 走査して、進み具合と結果をイベントで知らせる。
pub fn scan_and_notify(
    app: &tauri::AppHandle,
    state: &ProjectState,
    scope: ScanScope,
) -> Result<ScanSummary, IpcError> {
    let progress_app = app.clone();
    let summary = scan(state, scope, &move |progress| {
        if let Err(error) = ScanProgressEvent(progress).emit(&progress_app) {
            tracing::warn!(%error, "scan-progress を送れなかった");
        }
    })?;
    if let Some(changed) = AssetsChanged::from_summary(&summary)
        && let Err(error) = changed.emit(app)
    {
        tracing::warn!(%error, "assets-changed を送れなかった");
    }
    Ok(summary)
}

/// プロジェクトを開いた直後に、背景で走査を始める（開く処理を待たせない）。失敗は記録だけする。
pub fn start_auto_scan(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Manager;
        let state = app.state::<ProjectState>();
        if let Err(error) = scan_and_notify(&app, &state, ScanScope::Full) {
            tracing::warn!(code = %error.code, "開いたあとの走査に失敗した");
        }
    });
}

#[tauri::command(async)]
#[specta::specta]
pub fn asset_list(
    state: tauri::State<'_, ProjectState>,
    filter: AssetFilter,
    page: Page,
) -> Result<AssetPage, IpcError> {
    list(&state, &filter, &page)
}

#[tauri::command(async)]
#[specta::specta]
pub fn asset_scan(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    scope: Option<ScanScope>,
) -> Result<ScanSummary, IpcError> {
    scan_and_notify(&app, &state, scope.unwrap_or(ScanScope::Full))
}

#[tauri::command(async)]
#[specta::specta]
pub fn asset_scan_cancel(state: tauri::State<'_, ProjectState>) {
    cancel_scan(&state);
}

#[tauri::command(async)]
#[specta::specta]
pub fn asset_set_media_rules(
    state: tauri::State<'_, ProjectState>,
    rules: MediaRules,
) -> Result<u32, IpcError> {
    set_rules(&state, rules)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project_commands::{Hooks, open_project};
    use unnotator_core::assets::media::MediaRule;
    use unnotator_core::assets::scan::ScanScope;

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "unnotator-asset-ipc-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(path.join("project")).expect("一時フォルダを作れる");
            Self(path)
        }
        fn project(&self) -> std::path::PathBuf {
            self.0.join("project")
        }
        fn state(&self) -> ProjectState {
            ProjectState::new(self.0.join("recovery"))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn text_rules() -> MediaRules {
        let mut rules = MediaRules::new();
        rules
            .push(MediaRule {
                media_type: "test/text".to_owned(),
                extensions: vec!["txt".to_owned()],
                mime_types: vec![],
            })
            .expect("規則を足せる");
        rules
    }

    #[test]
    fn every_command_reports_not_open_while_nothing_is_open() {
        let temp = Temp::new();
        let state = temp.state();
        assert_eq!(
            list(&state, &AssetFilter::default(), &Page::first(10))
                .unwrap_err()
                .code,
            "not_open"
        );
        assert_eq!(
            scan(&state, ScanScope::Full, &|_| {}).unwrap_err().code,
            "not_open"
        );
        assert_eq!(
            set_rules(&state, MediaRules::new()).unwrap_err().code,
            "not_open"
        );
    }

    #[test]
    fn scan_list_and_rules_work_on_an_open_project() {
        let temp = Temp::new();
        std::fs::write(temp.project().join("a.txt"), b"abc").expect("書ける");
        std::fs::write(temp.project().join("b.xyz"), b"d").expect("書ける");
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");

        assert_eq!(set_rules(&state, text_rules()).expect("設定できる"), 0);
        let progress = std::sync::Mutex::new(Vec::new());
        let summary = scan(&state, ScanScope::Full, &|p| {
            progress.lock().expect("lock").push(p.found);
        })
        .expect("走査できる");
        assert_eq!(summary.added, 2);
        assert!(summary.complete);
        assert_eq!(progress.lock().expect("lock").last().copied(), Some(2));

        let page = list(&state, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].media_type.as_deref(), Some("test/text"));
        assert_eq!(page.items[1].media_type, None);

        // 規則を変えると、既存のアセットへ反映される
        assert_eq!(set_rules(&state, MediaRules::new()).expect("設定できる"), 1);
        let again = scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        assert_eq!(again.added + again.updated, 0);

        let changed = AssetsChanged::from_summary(&summary).expect("変化がある");
        assert_eq!((changed.added, changed.origin.as_str()), (2, "sync"));
        assert!(AssetsChanged::from_summary(&again).is_none());
    }

    #[test]
    fn cancel_before_scanning_does_not_stick_to_the_next_scan() {
        let temp = Temp::new();
        std::fs::write(temp.project().join("a.txt"), b"abc").expect("書ける");
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        cancel_scan(&state);
        let summary = scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        assert!(summary.complete, "中断の指示は、次の走査の開始で解除される");
    }
}
