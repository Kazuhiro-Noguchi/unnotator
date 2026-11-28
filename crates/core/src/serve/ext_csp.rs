//! 拡張機能の HTML（`unno://localhost/ext/<id>/...`）に付ける CSP の組み立て（research.md R6）。
//!
//! 拡張機能ごと・同意済みの権限ごとに作る。`connect-src` などは、権限によらず常に閉じる
//! （枠から本体の IPC や外部へ出られないことの土台。緩める引数は持たない）。

/// 組み立てに使う権限の名前（`assets.read` が同意済みなら、アセット・プレビューの読み込みを許す）。
const ASSETS_READ: &str = "assets.read";

/// ID の形（`url.rs` の `ext` の ID と同じ）。CSP の記述に入れてよい文字だけ。
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// `id` の拡張機能の HTML に付ける CSP。`granted` は、同意済みの権限。
///
/// ID の形が不正なら、何も読み込めない CSP を返す。
pub fn ext_csp(id: &str, granted: &[String]) -> String {
    if !is_safe_id(id) {
        return "default-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
            .to_owned();
    }
    // 自分のフォルダだけ。`unno:` 単独だと、他の拡張機能のファイルも読めてしまう
    // （S-02 の追加検証で、パス付きの指定が 3 OS で効くことを確認済み）。
    let own = format!("unno://localhost/ext/{id}/ http://unno.localhost/ext/{id}/");
    let loadable = if granted.iter().any(|p| p == ASSETS_READ) {
        "data: unno: http://unno.localhost".to_owned()
    } else {
        format!("data: {own}")
    };
    format!(
        "default-src 'none'; script-src {own}; style-src unno: http://unno.localhost; \
         img-src {loadable}; media-src {loadable}; font-src {loadable}; \
         connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directive<'a>(csp: &'a str, name: &str) -> Option<&'a str> {
        csp.split(';')
            .map(str::trim)
            .find_map(|d| d.strip_prefix(name)?.strip_prefix(' '))
    }

    fn grants(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn without_permissions_images_are_limited_to_data_and_its_own_folder() {
        let csp = ext_csp("com.example.text", &[]);
        for name in ["img-src", "media-src", "font-src"] {
            let d = directive(&csp, name).unwrap_or_else(|| panic!("{name} がある"));
            assert!(d.contains("data:"), "{name}: {d}");
            assert!(
                d.contains("unno://localhost/ext/com.example.text/")
                    && d.contains("http://unno.localhost/ext/com.example.text/"),
                "{name}: {d}"
            );
            // スキーム全体（`unno:` 単独）は許さない
            assert!(!d.split_whitespace().any(|s| s == "unno:"), "{name}: {d}");
            assert!(
                !d.split_whitespace().any(|s| s == "http://unno.localhost"),
                "{name}: {d}"
            );
        }
    }

    #[test]
    fn with_assets_read_the_unno_scheme_is_allowed_for_images_media_and_fonts() {
        let csp = ext_csp("com.example.text", &grants(&["assets.read"]));
        for name in ["img-src", "media-src", "font-src"] {
            let d = directive(&csp, name).expect("ある");
            assert!(d.split_whitespace().any(|s| s == "unno:"), "{name}: {d}");
            assert!(
                d.split_whitespace().any(|s| s == "http://unno.localhost"),
                "{name}: {d}"
            );
        }
    }

    #[test]
    fn other_permissions_do_not_open_assets() {
        let csp = ext_csp("com.example.text", &grants(&["labels.write", "network"]));
        let d = directive(&csp, "img-src").expect("ある");
        assert!(!d.split_whitespace().any(|s| s == "unno:"), "{d}");
    }

    #[test]
    fn script_src_is_only_the_extensions_own_path() {
        for granted in [grants(&[]), grants(&["assets.read", "network"])] {
            let csp = ext_csp("com.example.text", &granted);
            let d = directive(&csp, "script-src").expect("ある");
            assert_eq!(
                d,
                "unno://localhost/ext/com.example.text/ http://unno.localhost/ext/com.example.text/"
            );
            assert!(!csp.contains("'unsafe-inline'") && !csp.contains("'unsafe-eval'"));
        }
    }

    #[test]
    fn the_closing_directives_are_always_present_whatever_is_granted() {
        let all = grants(&[
            "assets.read",
            "network",
            "labels.write",
            "annotations.write",
        ]);
        for granted in [grants(&[]), all] {
            let csp = ext_csp("com.example.text", &granted);
            assert!(csp.starts_with("default-src 'none'"), "{csp}");
            for (name, value) in [
                ("connect-src", "'none'"),
                ("frame-src", "'none'"),
                ("base-uri", "'none'"),
                ("form-action", "'none'"),
            ] {
                assert_eq!(directive(&csp, name), Some(value), "{name}");
            }
        }
    }

    #[test]
    fn style_src_allows_the_unno_scheme_only() {
        let csp = ext_csp("com.example.text", &[]);
        assert_eq!(
            directive(&csp, "style-src"),
            Some("unno: http://unno.localhost")
        );
    }

    #[test]
    fn the_csp_of_one_extension_does_not_name_another() {
        let a = ext_csp("com.example.a", &[]);
        assert!(!a.contains("com.example.b"));
    }

    #[test]
    fn a_malformed_id_gets_a_csp_that_loads_nothing() {
        for id in ["", "A.b", "a b", "a;b", "a/../b", "a'b", "a\nb"] {
            let csp = ext_csp(id, &grants(&["assets.read"]));
            assert!(csp.starts_with("default-src 'none'"), "{id:?}");
            assert!(!csp.contains("unno"), "{id:?}: {csp}");
            assert_eq!(directive(&csp, "connect-src"), Some("'none'"));
        }
    }
}
