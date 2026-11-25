//! 型付き IPC の生成物（`src/ipc/bindings.ts`）がコミット済みの内容と一致することを確かめる（FR-012）。

use std::path::PathBuf;

fn normalize(text: &str) -> String {
    text.replace("\r\n", "\n")
}

#[test]
fn committed_bindings_match_generated() {
    let committed_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/bindings.ts");
    let committed = std::fs::read_to_string(&committed_path).unwrap_or_default();

    let dir = std::env::temp_dir().join(format!("unnotator-bindings-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("一時ディレクトリを作れる");
    let generated_path = dir.join("bindings.ts");
    crate::export_bindings(&generated_path).expect("型を生成できる");
    let generated = std::fs::read_to_string(&generated_path).expect("生成物を読める");
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(
        normalize(&committed),
        normalize(&generated),
        "src/ipc/bindings.ts が生成物と違う。`pnpm ipc:gen` を実行してコミットすること"
    );
}
