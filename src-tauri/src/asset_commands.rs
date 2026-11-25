//! アセットの IPC コマンド（contracts/ipc.md）。状態の保持と型の変換だけを行う薄い層。
//! 走査・一覧・判定規則の中身は `unnotator-core` にある。

use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use unnotator_core::assets::exclude::ExcludeSet;
use unnotator_core::assets::media::MediaRules;
use unnotator_core::assets::relink::RelinkCandidate;
use unnotator_core::assets::scan::{ScanProgress, ScanScope};
use unnotator_core::assets::watch::{NotifyWatcher, PollingWatcher, Throttled, Watcher};
use unnotator_core::assets::{AssetFilter, AssetPage, Page};
use unnotator_core::command::Command;
use unnotator_core::event::ChangeSet;
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
    // 適用は、小さなまとまりごとにロックを手放す（画面の操作が待たされない）
    let mut apply = with_store(state, |store| Ok(store.plan_apply(report)))?;
    while with_store(state, |store| store.apply_step(&mut apply))? {}
    Ok(apply.into_summary())
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

/// リンク切れのアセットの、再接続の候補。
pub fn relink_candidates(
    state: &ProjectState,
    asset_id: &str,
) -> Result<Vec<RelinkCandidate>, IpcError> {
    with_store(state, |store| store.relink_candidates(asset_id))
}

/// 再接続を確定する（Undo できる）。
pub fn relink(
    state: &ProjectState,
    asset_id: &str,
    root_key: &str,
    rel_path: &str,
) -> Result<ChangeSet, IpcError> {
    with_store(state, |store| {
        store.apply_command(Command::RelinkAsset {
            asset_id: asset_id.to_owned(),
            root_key: root_key.to_owned(),
            rel_path: rel_path.to_owned(),
        })
    })
}

/// アセットを、アノテーションごと削除する（Undo できる）。
pub fn delete(state: &ProjectState, asset_id: &str) -> Result<ChangeSet, IpcError> {
    with_store(state, |store| {
        store.apply_command(Command::DeleteAsset {
            asset_id: asset_id.to_owned(),
        })
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
    /// 利用者の操作（再接続・削除）の通知。`origin` は `relink` / `delete`。
    fn one(origin: &str, updated: u32, added: u32) -> Self {
        Self {
            added,
            updated,
            went_missing: 0,
            restored: 0,
            reclassified: 0,
            origin: origin.to_owned(),
        }
    }

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

/// プロジェクトを開いた直後に、背景で走査を始め、続けて見張りを始める（開く処理を待たせない）。失敗は記録だけする。
pub fn start_auto_scan(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        use tauri::Manager;
        let state = app.state::<ProjectState>();
        let generation = state.next_watch_generation();
        if let Err(error) = scan_and_notify(&app, &state, ScanScope::Full) {
            tracing::warn!(code = %error.code, "開いたあとの走査に失敗した");
        }
        run_watch(&app, generation);
    });
}

/// 見張りを進める間隔。通知の取りこぼしを待たせないため、短くする（定期走査は、これを間引いて使う）。
const WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);
/// 通知の見張りが、何回に 1 回（約 1 分）、全体の走査を求めるか（取りこぼしに備える）。
const NOTIFY_FULL_EVERY: u32 = 120;
/// 定期走査の見張りを、何回に 1 回（約 2 秒）進めるか。
const POLLING_EVERY: u32 = 4;
/// 定期走査の見張りが、進めるたびに何回に 1 回、全体の走査を求めるか（ファイルの中身だけの変更を拾う）。
const POLLING_FULL_EVERY: u32 = 30;

/// 見張りの状態。ルートと除外が変わったら、作り直す。
#[derive(Default)]
pub struct WatchLoop {
    watcher: Option<(WatchKey, Box<dyn Watcher>)>,
}

#[derive(PartialEq, Eq)]
struct WatchKey {
    roots: Vec<(String, std::path::PathBuf)>,
    exclude: Vec<String>,
}

/// 見張りを 1 回進める。変化があれば走査して、その結果を返す。
/// 設定ファイルが外から変わっていれば、読み直す（反映されると、購読者へ通知される）。
pub fn watch_step(
    state: &ProjectState,
    watch: &mut WatchLoop,
    progress: &dyn Fn(ScanProgress),
) -> Result<Option<ScanSummary>, IpcError> {
    let (enabled, key) = with_store(state, |store| {
        let _ = store.settings_reload();
        Ok((
            store.watch_enabled(),
            WatchKey {
                roots: store.watch_roots(),
                exclude: store.scan_options().exclude.clone(),
            },
        ))
    })?;
    if !enabled {
        watch.watcher = None;
        return Ok(None);
    }
    if watch
        .watcher
        .as_ref()
        .is_none_or(|(known, _)| *known != key)
    {
        let exclude = ExcludeSet::new(&key.exclude).unwrap_or_else(|_| ExcludeSet::defaults());
        // 通知を登録できればそれを使い、できなければ（権限・上限など）定期走査で代える
        let watcher: Box<dyn Watcher> =
            match NotifyWatcher::new(key.roots.clone(), exclude.clone(), NOTIFY_FULL_EVERY) {
                Ok(watcher) => Box::new(watcher),
                Err(error) => {
                    tracing::warn!(%error, "ファイルの通知を使えない。定期走査で代える");
                    Box::new(Throttled::new(
                        PollingWatcher::new(key.roots.clone(), exclude, POLLING_FULL_EVERY),
                        POLLING_EVERY,
                    ))
                }
            };
        watch.watcher = Some((key, watcher));
    }
    let Some((_, watcher)) = watch.watcher.as_mut() else {
        return Ok(None);
    };
    let batch = watcher.tick();
    if batch.is_empty() {
        return Ok(None);
    }
    match scan(state, batch.scope(), progress) {
        Ok(summary) => Ok(Some(summary)),
        // 開いた直後の全体の走査と重なった。その走査が見ているので、基準を取り直して、次から追う
        Err(error) if error.code == "scan_in_progress" => {
            watch.watcher = None;
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// 背景の見張り。世代が変わる（閉じる・別のプロジェクトを開く）か、プロジェクトが無くなったら止まる。
fn run_watch(app: &tauri::AppHandle, generation: u64) {
    use tauri::Manager;
    let state = app.state::<ProjectState>();
    let mut watch = WatchLoop::default();
    loop {
        // 短く区切って待つ（止める指示にすぐ反応するため）
        let mut waited = std::time::Duration::ZERO;
        while waited < WATCH_INTERVAL {
            if state.watch_generation() != generation {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            waited += std::time::Duration::from_millis(100);
        }
        let progress_app = app.clone();
        let result = watch_step(&state, &mut watch, &move |progress| {
            let _ = ScanProgressEvent(progress).emit(&progress_app);
        });
        match result {
            Ok(Some(summary)) => {
                if let Some(changed) = AssetsChanged::from_summary(&summary) {
                    emit_changed(app, changed);
                }
            }
            Ok(None) => {}
            Err(error) if error.code == "not_open" => return,
            Err(error) => tracing::warn!(code = %error.code, "見張りの走査に失敗した"),
        }
    }
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
pub fn asset_relink_candidates(
    state: tauri::State<'_, ProjectState>,
    asset_id: String,
) -> Result<Vec<RelinkCandidate>, IpcError> {
    relink_candidates(&state, &asset_id)
}

#[tauri::command(async)]
#[specta::specta]
pub fn asset_relink(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    asset_id: String,
    root_key: String,
    rel_path: String,
) -> Result<ChangeSet, IpcError> {
    let set = relink(&state, &asset_id, &root_key, &rel_path)?;
    emit_changed(&app, AssetsChanged::one("relink", 1, 0));
    Ok(set)
}

#[tauri::command(async)]
#[specta::specta]
pub fn asset_delete(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProjectState>,
    asset_id: String,
) -> Result<ChangeSet, IpcError> {
    let set = delete(&state, &asset_id)?;
    emit_changed(&app, AssetsChanged::one("delete", 0, 0));
    Ok(set)
}

fn emit_changed(app: &tauri::AppHandle, changed: AssetsChanged) {
    if let Err(error) = changed.emit(app) {
        tracing::warn!(%error, "assets-changed を送れなかった");
    }
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
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "unnotator-asset-ipc-{}-{}-{n}",
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
    fn missing_files_offer_candidates_and_relink_and_delete_are_undoable() {
        let temp = Temp::new();
        std::fs::write(temp.project().join("a.txt"), b"abc").expect("書ける");
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        let id = list(&state, &AssetFilter::default(), &Page::first(10))
            .expect("一覧")
            .items[0]
            .id
            .clone();

        std::fs::create_dir_all(temp.project().join("moved")).expect("作れる");
        std::fs::rename(
            temp.project().join("a.txt"),
            temp.project().join("moved/a.txt"),
        )
        .expect("動かせる");
        let summary = scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        assert_eq!((summary.added, summary.went_missing), (1, 1));

        let candidates = relink_candidates(&state, &id).expect("候補");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].rel_path, "moved/a.txt");

        relink(&state, &id, "", "moved/a.txt").expect("付け替えられる");
        let items = list(&state, &AssetFilter::default(), &Page::first(10))
            .expect("一覧")
            .items;
        assert_eq!(items.len(), 1);
        assert_eq!(
            (items[0].id.as_str(), items[0].missing),
            (id.as_str(), false)
        );

        delete(&state, &id).expect("削除できる");
        assert!(
            list(&state, &AssetFilter::default(), &Page::first(10))
                .expect("一覧")
                .items
                .is_empty()
        );
        crate::project_commands::undo_project(&state)
            .expect("戻せる")
            .expect("操作がある");
        assert_eq!(
            list(&state, &AssetFilter::default(), &Page::first(10))
                .expect("一覧")
                .items
                .len(),
            1
        );
        assert_eq!(delete(&state, "nope").unwrap_err().code, "not_found");
        assert_eq!(
            relink_candidates(&state, "nope").unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn the_watch_step_picks_up_new_files_and_stops_when_the_project_closes() {
        let temp = Temp::new();
        let state = temp.state();
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        let mut watch = WatchLoop::default();
        assert!(
            watch_step(&state, &mut watch, &|_| {})
                .expect("進む")
                .is_none(),
            "最初は基準"
        );

        std::fs::write(temp.project().join("new.txt"), b"1").expect("書ける");
        // 通知は、まとめるために少し待つ（5 秒以内に届く）
        let started = std::time::Instant::now();
        let summary = loop {
            if let Some(summary) = watch_step(&state, &mut watch, &|_| {}).expect("進む") {
                break summary;
            }
            assert!(
                started.elapsed() < std::time::Duration::from_secs(5),
                "5 秒以内に届く"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert_eq!(summary.added, 1);
        assert!(
            watch_step(&state, &mut watch, &|_| {})
                .expect("進む")
                .is_none()
        );

        // 設定で止められる
        crate::settings_commands::set(
            &state,
            unnotator_core::settings::Layer::Project,
            "assets.watch",
            "false",
        )
        .expect("設定できる");
        std::fs::write(temp.project().join("later.txt"), b"2").expect("書ける");
        assert!(
            watch_step(&state, &mut watch, &|_| {})
                .expect("進む")
                .is_none()
        );

        // 閉じると、世代が進み、見張りは止まる
        let generation = state.watch_generation();
        crate::project_commands::close_project(
            &state,
            Some(crate::project_commands::CloseChoice::Discard),
        )
        .expect("閉じられる");
        assert!(state.watch_generation() > generation);
        assert_eq!(
            watch_step(&state, &mut watch, &|_| {}).unwrap_err().code,
            "not_open"
        );
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
