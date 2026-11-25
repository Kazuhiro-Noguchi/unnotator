use std::path::Path;

fn main() {
    // `frontendDist`（../dist）が無いと generate_context! が失敗する。
    // dist/ は生成物でコミットしないので、クローン直後でも cargo だけで通るよう空の場所を用意する。
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist");
    if let Err(error) = std::fs::create_dir_all(&dist) {
        println!("cargo::warning=dist/ を作れなかった: {error}");
    }
    tauri_build::build();
}
