//! `src/ipc/bindings.ts` を生成し直す（`pnpm ipc:gen`）。ウィンドウは開かない。

use std::path::Path;

fn main() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/bindings.ts");
    if let Err(error) = unnotator_lib::export_bindings(&path) {
        eprintln!("bindings.ts を書き出せなかった: {error}");
        std::process::exit(1);
    }
}
