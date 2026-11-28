//! 拡張機能の枠の起動用ファイル（`ext/<id>/@host/<名前>` で返す。Rust に埋め込む）。
//!
//! 中身は `frame/` の生成物（`packages/frame-runtime` のバンドル）。拡張機能のファイルでは差し替えられない。

/// 予約パスで返せる名前。`url.rs` が、これ以外を 404 にする。
pub const HOST_FILE_NAMES: [&str; 2] = ["frame.html", "frame.js"];

/// 起動用ファイルの中身と `Content-Type`。
pub fn host_file(name: &str) -> Option<(&'static [u8], &'static str)> {
    match name {
        "frame.html" => Some((
            include_bytes!("frame/frame.html"),
            "text/html; charset=utf-8",
        )),
        "frame.js" => Some((
            include_bytes!("frame/frame.js"),
            "text/javascript; charset=utf-8",
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_reserved_name_has_a_file() {
        for name in HOST_FILE_NAMES {
            let (body, content_type) = host_file(name).expect("ある");
            assert!(!body.is_empty(), "{name}");
            assert!(content_type.contains("charset=utf-8"));
        }
        assert!(host_file("nothing.js").is_none());
    }
}
