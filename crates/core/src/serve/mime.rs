//! 拡張機能の静的ファイル（`unno://ext/`）の `Content-Type`。
//!
//! ブラウザが拡張機能の画面を動かすための「ウェブの部品」だけを持つ。媒体の種別の表は持たない
//! （アセットの `Content-Type` は、拡張機能の宣言から決まる）。

/// ファイル名の拡張子から、ウェブの部品の `Content-Type` を返す。
pub fn web_content_type(file_name: &str) -> Option<&'static str> {
    let ext = file_name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return None,
    })
}

pub const FALLBACK_CONTENT_TYPE: &str = "application/octet-stream";
