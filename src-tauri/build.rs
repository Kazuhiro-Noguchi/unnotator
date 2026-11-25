use std::path::Path;

fn main() {
    // `frontendDist`（../dist）が無いと generate_context! が失敗する。
    // dist/ は生成物でコミットしないので、クローン直後でも cargo だけで通るよう空の場所を用意する。
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if let Err(error) = std::fs::create_dir_all(&dist) {
        println!("cargo::warning=dist/ を作れなかった: {error}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Windows: テストの実行ファイルにも、Common Controls v6 のマニフェストを埋め込む（Tauri の既知の回避策）。
        // アプリ本体のマニフェストは、同じものを 1 つだけ埋め込むので、Tauri の既定のマニフェストは外す。
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-test.manifest");
        let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
        if let Err(error) =
            tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        {
            panic!("tauri_build に失敗した: {error}");
        }
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        println!("cargo:rerun-if-changed=windows-test.manifest");
    } else {
        tauri_build::build();
    }
}
