//! 「既定のアプリで開く」（specs/007-tree-preview/research.md R9）。
//! パスはアセットの ID から DB で引き、ルートの外に出ないことを実パスで確かめてから、
//! シェルを介さずに OS のコマンドへ 1 つの引数として渡す。

use std::path::Path;
use std::process::Command;

use unnotator_core::serve::{ServeError, confine_inside};

use crate::project_commands::{IpcError, ProjectState, with_store};

/// OS に、ファイルを既定のアプリで開かせる。テストでは差し替える。
pub trait Launcher {
    fn open(&self, path: &Path) -> std::io::Result<()>;
}

/// OS ごとのコマンドと引数。引数はパスだけ（シェルを使わない）。
fn program_for(path: &Path) -> (&'static str, Vec<std::ffi::OsString>) {
    let arg = path.as_os_str().to_owned();
    #[cfg(target_os = "macos")]
    {
        ("open", vec![arg])
    }
    #[cfg(target_os = "windows")]
    {
        ("explorer.exe", vec![arg])
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        ("xdg-open", vec![arg])
    }
}

pub struct SystemLauncher;

impl Launcher for SystemLauncher {
    fn open(&self, path: &Path) -> std::io::Result<()> {
        let (program, args) = program_for(path);
        Command::new(program).args(args).spawn().map(|_child| ())
    }
}

pub fn open_asset(
    state: &ProjectState,
    launcher: &dyn Launcher,
    asset_id: &str,
) -> Result<(), IpcError> {
    // ロックは、行を読む間だけ持つ。
    let file = with_store(state, |store| Ok(store.asset_file(asset_id)))?
        .map_err(|_| IpcError::missing(asset_id))?;
    let path = confine_inside(&file.root, &file.rel_path).map_err(|error| match error {
        ServeError::NotFound => IpcError::missing(&file.rel_path),
        _ => IpcError::path_outside(&file.rel_path),
    })?;
    launcher.open(&path).map_err(|error| IpcError {
        code: "open_failed".to_owned(),
        message: format!("既定のアプリで開けなかった: {error}"),
    })
}

#[tauri::command(async)]
#[specta::specta]
pub fn open_in_default_app(
    state: tauri::State<'_, ProjectState>,
    asset_id: String,
) -> Result<(), IpcError> {
    open_asset(&state, &SystemLauncher, &asset_id)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::asset_commands::{list, scan};
    use crate::project_commands::{Hooks, open_project};
    use unnotator_core::assets::scan::ScanScope;
    use unnotator_core::assets::{AssetFilter, Page};

    struct Recorder(RefCell<Vec<std::path::PathBuf>>);
    impl Launcher for Recorder {
        fn open(&self, path: &Path) -> std::io::Result<()> {
            self.0.borrow_mut().push(path.to_path_buf());
            Ok(())
        }
    }

    struct Failing;
    impl Launcher for Failing {
        fn open(&self, _path: &Path) -> std::io::Result<()> {
            Err(std::io::Error::other("no handler"))
        }
    }

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "unnotator-open-{}-{}-{n}",
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
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn open_with(temp: &Temp, files: &[&str]) -> ProjectState {
        for f in files {
            std::fs::write(temp.project().join(f), b"x").expect("書ける");
        }
        let state = ProjectState::new(temp.0.join("recovery"));
        open_project(&state, &temp.project(), true, Hooks::default()).expect("作れる");
        scan(&state, ScanScope::Full, &|_| {}).expect("走査できる");
        state
    }

    fn id_of(state: &ProjectState, path: &str) -> String {
        list(state, &AssetFilter::default(), &Page::first(50))
            .expect("一覧")
            .items
            .iter()
            .find(|a| a.rel_path == path)
            .expect("ある")
            .id
            .clone()
    }

    #[test]
    fn the_resolved_real_path_is_passed_to_the_launcher() {
        let temp = Temp::new();
        let state = open_with(&temp, &["a.txt"]);
        let recorder = Recorder(RefCell::new(Vec::new()));
        open_asset(&state, &recorder, &id_of(&state, "a.txt")).expect("開ける");
        let opened = recorder.0.borrow();
        assert_eq!(opened.len(), 1);
        assert!(opened[0].ends_with("a.txt"));
        assert!(opened[0].is_absolute());
    }

    #[test]
    fn special_characters_in_the_name_stay_one_argument() {
        let name = "we ird $(x); 'q' \"d\" &.txt";
        let (program, args) = program_for(Path::new(name));
        assert!(!program.is_empty());
        assert_eq!(args.len(), 1, "引数は 1 つだけ（シェルで分割されない）");
        assert_eq!(args[0], std::ffi::OsString::from(name));
    }

    #[test]
    fn an_asset_whose_file_is_gone_is_reported_as_missing() {
        let temp = Temp::new();
        let state = open_with(&temp, &["a.txt"]);
        let id = id_of(&state, "a.txt");
        std::fs::remove_file(temp.project().join("a.txt")).expect("消せる");
        let error = open_asset(&state, &Recorder(RefCell::new(Vec::new())), &id).unwrap_err();
        assert_eq!(error.code, "missing");
    }

    #[test]
    fn an_unknown_asset_is_missing() {
        let temp = Temp::new();
        let state = open_with(&temp, &["a.txt"]);
        let error = open_asset(&state, &Recorder(RefCell::new(Vec::new())), "nope").unwrap_err();
        assert_eq!(error.code, "missing");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_pointing_outside_the_root_is_refused() {
        let temp = Temp::new();
        std::fs::write(temp.0.join("outside.txt"), b"secret").expect("書ける");
        let state = open_with(&temp, &["a.txt"]);
        let id = id_of(&state, "a.txt");
        std::fs::remove_file(temp.project().join("a.txt")).expect("消せる");
        std::os::unix::fs::symlink(temp.0.join("outside.txt"), temp.project().join("a.txt"))
            .expect("リンクを作れる");
        let recorder = Recorder(RefCell::new(Vec::new()));
        let error = open_asset(&state, &recorder, &id).unwrap_err();
        assert_eq!(error.code, "path_outside");
        assert!(recorder.0.borrow().is_empty());
    }

    #[test]
    fn a_launcher_failure_becomes_an_error_not_a_crash() {
        let temp = Temp::new();
        let state = open_with(&temp, &["a.txt"]);
        let error = open_asset(&state, &Failing, &id_of(&state, "a.txt")).unwrap_err();
        assert_eq!(error.code, "open_failed");
    }

    #[test]
    fn nothing_opens_while_no_project_is_open() {
        let temp = Temp::new();
        let state = ProjectState::new(temp.0.join("recovery"));
        let error = open_asset(&state, &Failing, "x").unwrap_err();
        assert_eq!(error.code, "not_open");
    }

    #[test]
    fn opening_does_not_change_the_project() {
        let temp = Temp::new();
        let state = open_with(&temp, &["a.txt"]);
        let before = crate::project_commands::project_save_state(&state).expect("状態");
        open_asset(
            &state,
            &Recorder(RefCell::new(Vec::new())),
            &id_of(&state, "a.txt"),
        )
        .expect("開ける");
        let after = crate::project_commands::project_save_state(&state).expect("状態");
        assert_eq!(before.dirty, after.dirty);
    }
}
