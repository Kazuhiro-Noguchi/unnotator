//! `unno://` のパスの解釈。区切りごとにパーセントの表記を 1 回だけ展開し、展開後に危ない成分を拒む。

use super::ServeError;

/// 配信の対象。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// アセット本体（アセット ID）。
    Asset(String),
    /// プレビュー用のサムネイル（アセット ID）。
    Preview(String),
    /// 拡張機能の静的ファイル。
    Ext { id: String, rest: Vec<String> },
    /// 起動用の予約パス（`ext/<id>/@host/<名前>`）。拡張機能のファイルより優先する。
    ExtHost { id: String, name: String },
    /// ブロブの置き場の直下のファイル名。
    Blob(String),
}

const MAX_PATH_BYTES: usize = 4_096;
const MAX_SEGMENT_BYTES: usize = 255;

fn bad(why: &str) -> ServeError {
    ServeError::BadRequest(why.to_owned())
}

/// `%XY` を 1 回だけ展開する。展開後が UTF-8 でなければ拒む。
fn unescape_once(segment: &str) -> Result<String, ServeError> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes
                .get(i + 1..i + 3)
                .ok_or_else(|| bad("%の後が足りない"))?;
            let hi = (hex[0] as char).to_digit(16);
            let lo = (hex[1] as char).to_digit(16);
            let (Some(hi), Some(lo)) = (hi, lo) else {
                return Err(bad("%の後が 16 進数でない"));
            };
            out.push(u8::try_from(hi * 16 + lo).map_err(|_| bad("値が大きすぎる"))?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| bad("UTF-8 でない"))
}

/// 展開後の成分が安全か（区切り・親への参照・制御文字・ドライブ指定などを持たない）。
pub(crate) fn check_segment(segment: &str) -> Result<(), ServeError> {
    if segment.is_empty() {
        return Err(bad("空の成分"));
    }
    if segment.len() > MAX_SEGMENT_BYTES {
        return Err(bad("成分が長すぎる"));
    }
    if segment == "." || segment == ".." {
        return Err(bad("親や自分への参照"));
    }
    if segment
        .chars()
        .any(|c| matches!(c, '/' | '\\' | ':') || c.is_control())
    {
        return Err(bad("使えない文字"));
    }
    Ok(())
}

/// パス（`/<kind>/<rest>`。クエリと断片は無視する）を解釈する。
pub fn parse_target(path: &str) -> Result<Target, ServeError> {
    if path.len() > MAX_PATH_BYTES {
        return Err(bad("パスが長すぎる"));
    }
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let rest = path
        .strip_prefix('/')
        .ok_or_else(|| bad("先頭が / でない"))?;
    let mut segments = Vec::new();
    for raw in rest.split('/') {
        let segment = unescape_once(raw)?;
        check_segment(&segment)?;
        segments.push(segment);
    }
    let kind = segments[0].as_str();
    match (kind, segments.len()) {
        ("asset", 2) => Ok(Target::Asset(segments.swap_remove(1))),
        ("preview", 2) => Ok(Target::Preview(segments.swap_remove(1))),
        ("blob", 2) => Ok(Target::Blob(segments.swap_remove(1))),
        ("ext", n) if n >= 3 => {
            let id = segments[1].clone();
            if !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
            {
                return Err(bad("拡張機能の ID の形でない"));
            }
            Ok(Target::Ext {
                id,
                rest: segments.split_off(2),
            })
        }
        _ => Err(bad("未対応の経路")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn host(id: &str, name: &str) -> Target {
        Target::ExtHost {
            id: id.to_owned(),
            name: name.to_owned(),
        }
    }

    #[test]
    fn the_reserved_host_path_is_parsed_before_extension_files() {
        assert_eq!(
            parse_target("/ext/com.example.text/@host/frame.html").unwrap(),
            host("com.example.text", "frame.html")
        );
        assert_eq!(
            parse_target("/ext/com.example.text/@host/frame.js").unwrap(),
            host("com.example.text", "frame.js")
        );
        // クエリは名前に含まれない
        assert_eq!(
            parse_target("/ext/a.b/@host/frame.html?role=editor").unwrap(),
            host("a.b", "frame.html")
        );
    }

    #[test]
    fn an_escaped_at_sign_is_still_reserved() {
        assert_eq!(
            parse_target("/ext/a.b/%40host/frame.html").unwrap(),
            host("a.b", "frame.html")
        );
    }

    #[test]
    fn an_unknown_host_name_is_not_found() {
        assert_eq!(
            parse_target("/ext/a.b/@host/nothing.js"),
            Err(ServeError::NotFound)
        );
    }

    #[test]
    fn the_reserved_segment_never_falls_back_to_a_package_file() {
        // `@host` 単独・深い入れ子は、予約に属する不正なパス（ファイルとして返さない）
        for path in ["/ext/a.b/@host", "/ext/a.b/@host/x/y", "/ext/a.b/%40host/x/y"] {
            assert!(
                matches!(parse_target(path), Err(ServeError::BadRequest(_))),
                "{path}"
            );
        }
    }

    #[test]
    fn existing_ext_paths_do_not_change() {
        let ext = |id: &str, rest: &[&str]| Target::Ext {
            id: id.to_owned(),
            rest: rest.iter().map(|s| (*s).to_owned()).collect(),
        };
        assert_eq!(
            parse_target("/ext/a.b/dist/index.js").unwrap(),
            ext("a.b", &["dist", "index.js"])
        );
        // `@host` が先頭の成分でなければ、普通のファイル
        assert_eq!(
            parse_target("/ext/a.b/dist/@host/frame.html").unwrap(),
            ext("a.b", &["dist", "@host", "frame.html"])
        );
        // `@` で始まるだけの別の名前も普通のファイル
        assert_eq!(
            parse_target("/ext/a.b/@hosts/x.js").unwrap(),
            ext("a.b", &["@hosts", "x.js"])
        );
        assert_eq!(
            parse_target("/ext/a.b/@hostile.js").unwrap(),
            ext("a.b", &["@hostile.js"])
        );
    }
}
