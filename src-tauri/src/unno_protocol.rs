//! `unno://` の配信（contracts/protocol.md）。要求の解釈・閉じ込め・Range は `unnotator_core::serve` にあり、
//! ここは、開いているプロジェクト・登録簿の情報を引いて、その結果を Tauri の応答に直す薄い層。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};

use unnotator_core::serve::mime::{EXT_HTML_CSP, FALLBACK_CONTENT_TYPE, web_content_type};
use unnotator_core::serve::{
    BYTE_BUDGET, BlobStore, Budget, MAX_CONCURRENT, PreviewCache, ResponseContext, ServeError,
    ServeResponse, Target, confine_inside, confine_no_links, error_response, parse_target,
    preflight_response, respond_file,
};
use unnotator_extensions::registry::{ExtensionStatus, MimeRules, Registry};
use unnotator_extensions::state::ExtensionsState;

use crate::project_commands::{ProjectState, with_store};

/// 配信の数え上げ（自己診断が読む）。
#[derive(Default)]
pub struct ServeStats {
    pub requests: AtomicU64,
    /// `Range` つきの要求の数。
    pub ranged: AtomicU64,
}

/// 配信が使う、登録簿由来の情報。登録簿が作り直されるたびに `update` で入れ替える。
pub struct ServeState {
    pub stats: ServeStats,
    pub blobs: BlobStore,
    pub previews: PreviewCache,
    pub budget: Budget,
    /// 有効な拡張機能の ID → 展開先のフォルダ。
    ext_dirs: RwLock<BTreeMap<String, PathBuf>>,
    mime: RwLock<MimeRules>,
}

impl ServeState {
    pub fn new(blobs: BlobStore, previews: PreviewCache) -> Self {
        Self {
            stats: ServeStats::default(),
            blobs,
            previews,
            budget: Budget::new(BYTE_BUDGET, MAX_CONCURRENT),
            ext_dirs: RwLock::new(BTreeMap::new()),
            mime: RwLock::new(MimeRules::default()),
        }
    }

    /// 登録簿の作り直しに合わせて、拡張機能のフォルダと `Content-Type` の対応を入れ替える。
    pub fn update(&self, registry: &Registry, state: &ExtensionsState) {
        let dirs = registry
            .extensions()
            .iter()
            .filter(|e| matches!(e.status, ExtensionStatus::Enabled { .. }))
            .map(|e| (e.id.clone(), e.dir.clone()))
            .collect();
        if let Ok(mut slot) = self.ext_dirs.write() {
            *slot = dirs;
        }
        if let Ok(mut slot) = self.mime.write() {
            *slot = registry.mime_rules(state);
        }
    }

    fn ext_dir(&self, id: &str) -> Option<PathBuf> {
        self.ext_dirs.read().ok()?.get(id).cloned()
    }

    fn content_type_of(&self, file_name: &str) -> String {
        self.mime
            .read()
            .ok()
            .and_then(|m| m.for_file_name(file_name).map(str::to_owned))
            .unwrap_or_else(|| FALLBACK_CONTENT_TYPE.to_owned())
    }
}

/// 要求の、配信に要る部分。
pub struct UnnoRequest<'a> {
    pub method: &'a str,
    /// `/asset/...` などのパス（クエリを含んでよい）。
    pub path: &'a str,
    pub range: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
}

/// 1 つの要求に応える（Tauri に依らない。テストはここを呼ぶ）。
pub fn handle(
    project: &ProjectState,
    serve: &ServeState,
    request: &UnnoRequest<'_>,
) -> ServeResponse {
    serve.stats.requests.fetch_add(1, Ordering::Relaxed);
    if request.range.is_some() {
        serve.stats.ranged.fetch_add(1, Ordering::Relaxed);
    }
    let head = match request.method {
        "GET" => false,
        "HEAD" => true,
        "OPTIONS" => return preflight_response(),
        _ => return error_response(405),
    };
    let target = match parse_target(request.path) {
        Ok(target) => target,
        Err(e) => return e.to_response(),
    };
    match respond(project, serve, &target, request, head) {
        Ok(response) => response,
        Err(e) => e.to_response(),
    }
}

/// クエリに `preview=1` があるか。
fn has_preview_flag(path: &str) -> bool {
    path.split_once('?')
        .map(|(_, q)| q.split('&').any(|kv| kv == "preview=1"))
        .unwrap_or(false)
}

/// 汎用プレビューが表示する形式だけの、拡張子 → 種別。媒体の表ではなく、表示専用の小さな表。
fn preview_content_type(file_name: &str) -> Option<&'static str> {
    let ext = file_name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn respond(
    project: &ProjectState,
    serve: &ServeState,
    target: &Target,
    request: &UnnoRequest<'_>,
    head: bool,
) -> Result<ServeResponse, ServeError> {
    let (path, content_type, etag, extra): (PathBuf, String, bool, Vec<(String, String)>) =
        match target {
            Target::Asset(id) => {
                // ロックは、行を読む間だけ持つ。ファイルの読み取りの前に手放す
                let file = with_store(project, |store| Ok(store.asset_file(id)))
                    .map_err(|_| ServeError::NotFound)?
                    .map_err(|_| ServeError::NotFound)?;
                let path = confine_inside(&file.root, &file.rel_path)?;
                let name = file.rel_path.rsplit('/').next().unwrap_or(&file.rel_path);
                let mut content_type = serve.content_type_of(name);
                let mut extra = Vec::new();
                // 汎用プレビュー（表示専用）: 拡張機能が種別を宣言していないアセットでも、画像・PDF を
                // ブラウザが表示できるよう、`?preview=1` のときだけ、拡張子から表示用の種別を付ける。
                if content_type == FALLBACK_CONTENT_TYPE
                    && has_preview_flag(request.path)
                    && let Some(shown) = preview_content_type(name)
                {
                    content_type = shown.to_owned();
                    if shown == "image/svg+xml" {
                        // SVG は、画像としてだけ使わせる（スクリプトを動かさない）。
                        extra.push((
                            "Content-Security-Policy".to_owned(),
                            "default-src 'none'; style-src 'unsafe-inline'; sandbox".to_owned(),
                        ));
                    }
                }
                (path, content_type, true, extra)
            }
            Target::Preview(id) => {
                let path = serve.previews.resolve(id)?;
                let content_type = serve
                    .previews
                    .content_type(id)
                    .unwrap_or_else(|| FALLBACK_CONTENT_TYPE.to_owned());
                (path, content_type, true, Vec::new())
            }
            Target::Blob(name) => {
                let path = serve.blobs.resolve(name)?;
                (path, serve.content_type_of(name), true, Vec::new())
            }
            Target::Ext { id, rest } => {
                let dir = serve.ext_dir(id).ok_or(ServeError::NotFound)?;
                let path = confine_no_links(&dir, rest)?;
                let name = rest.last().map(String::as_str).unwrap_or_default();
                let content_type = web_content_type(name)
                    .unwrap_or(FALLBACK_CONTENT_TYPE)
                    .to_owned();
                let extra = if content_type.starts_with("text/html") {
                    vec![(
                        "Content-Security-Policy".to_owned(),
                        EXT_HTML_CSP.to_owned(),
                    )]
                } else {
                    Vec::new()
                };
                (path, content_type, false, extra)
            }
        };
    let mut ctx = ResponseContext::new(&content_type);
    ctx.head = head;
    ctx.range = request.range;
    ctx.if_none_match = request.if_none_match;
    ctx.etag = etag;
    ctx.extra_headers = extra;
    ctx.budget = Some(&serve.budget);
    Ok(respond_file(&path, &ctx))
}

/// Tauri のカスタムプロトコルとして登録する。要求ごとに背景のスレッドで処理し、UI のスレッドでは何も読まない。
pub fn register<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    use tauri::Manager;
    builder.register_asynchronous_uri_scheme_protocol("unno", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        tauri::async_runtime::spawn_blocking(move || {
            let header = |name: &str| {
                request
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned)
            };
            let range = header("range");
            let if_none_match = header("if-none-match");
            let uri_path = request.uri().path().to_owned();
            let query = request.uri().query();
            let path = match query {
                Some(q) => format!("{uri_path}?{q}"),
                None => uri_path,
            };
            let response = match (
                app.try_state::<ProjectState>(),
                app.try_state::<ServeState>(),
            ) {
                (Some(project), Some(serve)) => handle(
                    &project,
                    &serve,
                    &UnnoRequest {
                        method: request.method().as_str(),
                        path: &path,
                        range: range.as_deref(),
                        if_none_match: if_none_match.as_deref(),
                    },
                ),
                _ => error_response(503),
            };
            responder.respond(to_http(response));
        });
    })
}

fn to_http(response: ServeResponse) -> tauri::http::Response<std::borrow::Cow<'static, [u8]>> {
    let mut builder = tauri::http::Response::builder().status(response.status);
    for (name, value) in &response.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(std::borrow::Cow::Owned(response.body))
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(std::borrow::Cow::Borrowed(&[][..]))
                .expect("空の応答は作れる")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_commands::{list, scan};
    use crate::project_commands::{Hooks, open_project};
    use unnotator_core::assets::scan::ScanScope;
    use unnotator_core::assets::{AssetFilter, Page};
    use unnotator_extensions::manifest::Manifest;
    use unnotator_extensions::registry::{Origin, RawExtension, RegistryInput};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "unnotator-unno-{}-{}-{n}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            std::fs::create_dir_all(path.join("project")).expect("作れる");
            std::fs::create_dir_all(path.join("blobs")).expect("作れる");
            std::fs::create_dir_all(path.join("previews")).expect("作れる");
            std::fs::create_dir_all(path.join("ext/dist")).expect("作れる");
            std::fs::create_dir_all(path.join("ext/views")).expect("作れる");
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn serve_state(temp: &Temp) -> ServeState {
        ServeState::new(
            BlobStore::open(temp.0.join("blobs")).expect("開ける"),
            PreviewCache::new(temp.0.join("previews")),
        )
    }

    fn registry_with_text_extension(temp: &Temp, disabled: bool) -> (Registry, ExtensionsState) {
        let manifest = serde_json::json!({
            "id": "com.example.text", "version": "1.0.0",
            "engines": { "unnotator": "^1.0.0" }, "main": "dist/index.js",
            "contributes": { "mediaTypes": [
                { "id": "text", "title": "text", "extensions": [".txt"], "mimeTypes": ["text/plain"] }
            ] }
        });
        let raw = RawExtension::new(
            temp.0.join("ext"),
            Origin::Installed,
            Manifest::from_value(manifest).expect("読める"),
        );
        let mut state = ExtensionsState::default();
        state.set_disabled("com.example.text", disabled);
        let registry = Registry::build(RegistryInput {
            installed: &[raw],
            state: &state,
            app_api_version: "1.0.0",
        });
        (registry, state)
    }

    fn get(path: &str) -> UnnoRequest<'_> {
        UnnoRequest {
            method: "GET",
            path,
            range: None,
            if_none_match: None,
        }
    }

    fn project_state(temp: &Temp) -> ProjectState {
        ProjectState::new(temp.0.join("recovery"))
    }

    #[test]
    fn bad_paths_methods_and_a_closed_project_get_plain_errors() {
        let temp = Temp::new();
        let project = project_state(&temp);
        let serve = serve_state(&temp);
        assert_eq!(handle(&project, &serve, &get("/nothing/x")).status, 400);
        assert_eq!(handle(&project, &serve, &get("/blob/%2e%2e")).status, 400);
        assert_eq!(
            handle(&project, &serve, &get("/asset/some-id")).status,
            404,
            "プロジェクトが開いていない"
        );
        let post = UnnoRequest {
            method: "POST",
            ..get("/asset/x")
        };
        assert_eq!(handle(&project, &serve, &post).status, 405);
        let options = UnnoRequest {
            method: "OPTIONS",
            ..get("/asset/x")
        };
        let r = handle(&project, &serve, &options);
        assert_eq!(r.status, 204);
        assert!(
            r.header("access-control-allow-headers")
                .expect("ある")
                .contains("Range")
        );
    }

    #[test]
    fn preview_flag_gives_a_display_type_only_to_undeclared_viewable_files() {
        let temp = Temp::new();
        for name in ["m.pdf", "p.png", "v.svg", "z.zzz", "a.txt"] {
            std::fs::write(temp.0.join("project").join(name), b"x").expect("書ける");
        }
        let project = project_state(&temp);
        open_project(&project, &temp.0.join("project"), true, Hooks::default()).expect("作れる");
        scan(&project, ScanScope::Full, &|_| {}).expect("走査できる");
        let serve = serve_state(&temp);
        let (registry, state) = registry_with_text_extension(&temp, false);
        serve.update(&registry, &state);
        let page = list(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        let id_of = |name: &str| {
            page.items
                .iter()
                .find(|a| a.rel_path == name)
                .expect("ある")
                .id
                .clone()
        };
        let ct = |name: &str, flag: bool| {
            let path = if flag {
                format!("/asset/{}?preview=1", id_of(name))
            } else {
                format!("/asset/{}", id_of(name))
            };
            let r = handle(&project, &serve, &get(&path));
            assert_eq!(r.status, 200, "{name}");
            (
                r.header("content-type").map(str::to_owned),
                r.header("content-security-policy").map(str::to_owned),
            )
        };
        assert_eq!(ct("m.pdf", true).0.as_deref(), Some("application/pdf"));
        assert_eq!(ct("p.png", true).0.as_deref(), Some("image/png"));
        let (svg, csp) = ct("v.svg", true);
        assert_eq!(svg.as_deref(), Some("image/svg+xml"));
        assert!(csp.is_some_and(|c| c.contains("sandbox")));
        // 旗が無ければ、従来どおり（宣言が無ければ octet-stream）
        assert_eq!(
            ct("m.pdf", false).0.as_deref(),
            Some("application/octet-stream")
        );
        // 表にない形式・宣言のある種別は、旗があっても変えない
        assert_eq!(
            ct("z.zzz", true).0.as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(ct("a.txt", true).0.as_deref(), Some("text/plain"));
    }

    #[test]
    fn an_asset_is_served_with_a_declared_content_type_range_and_etag() {
        let temp = Temp::new();
        std::fs::write(temp.0.join("project/a.txt"), b"hello").expect("書ける");
        std::fs::write(temp.0.join("project/b.unknown"), b"xyz").expect("書ける");
        let project = project_state(&temp);
        open_project(&project, &temp.0.join("project"), true, Hooks::default()).expect("作れる");
        scan(&project, ScanScope::Full, &|_| {}).expect("走査できる");
        let serve = serve_state(&temp);
        let (registry, state) = registry_with_text_extension(&temp, false);
        serve.update(&registry, &state);

        let page = list(&project, &AssetFilter::default(), &Page::first(10)).expect("一覧");
        let id_of = |name: &str| {
            page.items
                .iter()
                .find(|a| a.rel_path == name)
                .expect("ある")
                .id
                .clone()
        };
        let text_id = id_of("a.txt");

        let r = handle(&project, &serve, &get(&format!("/asset/{text_id}")));
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"hello");
        assert_eq!(r.header("content-type"), Some("text/plain"));
        let etag = r.header("etag").expect("ある").to_owned();

        let asset_path = format!("/asset/{text_id}");
        let ranged = UnnoRequest {
            range: Some("bytes=1-2"),
            ..get(&asset_path)
        };
        let r = handle(&project, &serve, &ranged);
        assert_eq!((r.status, r.body.as_slice()), (206, &b"el"[..]));
        assert_eq!(r.header("content-range"), Some("bytes 1-2/5"));

        let cached = UnnoRequest {
            if_none_match: Some(&etag),
            ..get(&asset_path)
        };
        assert_eq!(handle(&project, &serve, &cached).status, 304);

        // 宣言の無い拡張子は、中身を決めつけない
        let r = handle(
            &project,
            &serve,
            &get(&format!("/asset/{}", id_of("b.unknown"))),
        );
        assert_eq!(r.header("content-type"), Some("application/octet-stream"));

        // ファイルが消えて、リンク切れになったら配信しない
        std::fs::remove_file(temp.0.join("project/a.txt")).expect("消せる");
        scan(&project, ScanScope::Full, &|_| {}).expect("走査できる");
        assert_eq!(
            handle(&project, &serve, &get(&format!("/asset/{text_id}"))).status,
            404
        );
    }

    #[test]
    fn blobs_and_previews_are_read_from_their_folders_only() {
        let temp = Temp::new();
        let project = project_state(&temp);
        let serve = serve_state(&temp);
        std::fs::write(temp.0.join("blobs/out-1.bin"), b"blob").expect("書ける");
        std::fs::write(temp.0.join("previews/asset-9"), b"thumb").expect("書ける");
        std::fs::write(temp.0.join("previews/asset-9.type"), "application/x-thumb")
            .expect("書ける");

        let r = handle(&project, &serve, &get("/blob/out-1.bin"));
        assert_eq!((r.status, r.body.as_slice()), (200, &b"blob"[..]));
        assert_eq!(
            handle(&project, &serve, &get("/blob/missing.bin")).status,
            404
        );
        let r = handle(&project, &serve, &get("/preview/asset-9"));
        assert_eq!(r.body, b"thumb");
        assert_eq!(r.header("content-type"), Some("application/x-thumb"));
        assert_eq!(
            handle(&project, &serve, &get("/preview/asset-0")).status,
            404
        );
    }

    #[test]
    fn extension_files_are_served_only_for_enabled_extensions_and_inside_their_folder() {
        let temp = Temp::new();
        std::fs::write(temp.0.join("ext/dist/index.js"), b"export {}").expect("書ける");
        std::fs::write(temp.0.join("ext/views/a.html"), b"<p>hi</p>").expect("書ける");
        std::fs::write(temp.0.join("secret.txt"), b"secret").expect("書ける");
        let project = project_state(&temp);
        let serve = serve_state(&temp);
        let (registry, state) = registry_with_text_extension(&temp, false);
        serve.update(&registry, &state);

        let r = handle(
            &project,
            &serve,
            &get("/ext/com.example.text/dist/index.js"),
        );
        assert_eq!(r.status, 200);
        assert_eq!(
            r.header("content-type"),
            Some("text/javascript; charset=utf-8")
        );
        let r = handle(&project, &serve, &get("/ext/com.example.text/views/a.html"));
        assert!(
            r.header("content-security-policy")
                .expect("ある")
                .contains("default-src 'none'")
        );
        assert_eq!(
            handle(
                &project,
                &serve,
                &get("/ext/com.example.other/dist/index.js")
            )
            .status,
            404
        );
        assert_eq!(
            handle(&project, &serve, &get("/ext/com.example.text/dist/none.js")).status,
            404
        );
        assert_eq!(
            handle(
                &project,
                &serve,
                &get("/ext/com.example.text/%2e%2e/secret.txt")
            )
            .status,
            400
        );

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(temp.0.join("secret.txt"), temp.0.join("ext/dist/leak.js"))
                .expect("作れる");
            assert_eq!(
                handle(&project, &serve, &get("/ext/com.example.text/dist/leak.js")).status,
                403
            );
        }

        // 無効にした拡張機能は、配信しない
        let (registry, state) = registry_with_text_extension(&temp, true);
        serve.update(&registry, &state);
        assert_eq!(
            handle(
                &project,
                &serve,
                &get("/ext/com.example.text/dist/index.js")
            )
            .status,
            404
        );
    }
}
