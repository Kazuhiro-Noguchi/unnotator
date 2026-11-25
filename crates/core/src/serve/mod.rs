//! `unno://` の配信の本体（Tauri 非依存）。URL の解釈・パスの閉じ込め・Range・バイト予算・ブロブ。
//!
//! 媒体の種類は知らない。`Content-Type` は呼び出し側（登録簿の宣言）が決めて渡す（憲章 I）。
//! 応答の本体は `Vec<u8>`（Tauri のカスタムプロトコルはストリームでない）なので、
//! 1 回の応答の大きさに上限を置き、配信中の本体の合計にバイト予算を置く（research.md R9）。

pub mod blob;
pub mod budget;
pub mod confine;
pub mod mime;
pub mod range;
pub mod url;

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub use blob::{BlobStore, PreviewCache};
pub use budget::{Budget, Permit};
pub use confine::{confine_inside, confine_no_links};
pub use range::{RangeOutcome, parse_range};
pub use url::{Target, parse_target};

use thiserror::Error;

use crate::error::StoreError;

/// 1 回の Range 応答の大きさの上限。
pub const RANGE_CHUNK: u64 = 4 * 1024 * 1024;
/// Range なしで返せるファイルの大きさの上限。
pub const FULL_LIMIT: u64 = 96 * 1024 * 1024;
/// 配信中の本体の合計の上限。
pub const BYTE_BUDGET: u64 = 128 * 1024 * 1024;
/// 同時に配信する要求の数の上限。
pub const MAX_CONCURRENT: usize = 8;
/// 予算が空くのを待つ時間。
pub const BUDGET_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ServeError {
    #[error("不正な要求です: {0}")]
    BadRequest(String),
    #[error("見つかりません")]
    NotFound,
    #[error("許可されていません")]
    Forbidden,
    #[error("大きすぎます")]
    TooLarge,
    #[error("混み合っています")]
    Busy,
    #[error("読み取りに失敗しました")]
    Internal,
}

impl ServeError {
    pub fn status(&self) -> u16 {
        match self {
            ServeError::BadRequest(_) => 400,
            ServeError::NotFound => 404,
            ServeError::Forbidden => 403,
            ServeError::TooLarge => 413,
            ServeError::Busy => 503,
            ServeError::Internal => 500,
        }
    }

    /// 内部のパスなどを含まない、短い応答にする。
    pub fn to_response(&self) -> ServeResponse {
        error_response(self.status())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl ServeResponse {
    /// ヘッダーの値（名前は大文字小文字を区別しない）。
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        416 => "Range Not Satisfiable",
        503 => "Service Unavailable",
        _ => "Internal Server Error",
    }
}

fn common_headers() -> Vec<(String, String)> {
    vec![
        ("X-Content-Type-Options".to_owned(), "nosniff".to_owned()),
        (
            "Cross-Origin-Resource-Policy".to_owned(),
            "cross-origin".to_owned(),
        ),
        ("Access-Control-Allow-Origin".to_owned(), "*".to_owned()),
        (
            "Access-Control-Expose-Headers".to_owned(),
            "Content-Range, Content-Length, Accept-Ranges, ETag".to_owned(),
        ),
    ]
}

/// CORS の事前確認（`OPTIONS`）への応答。
pub fn preflight_response() -> ServeResponse {
    let mut headers = common_headers();
    headers.push((
        "Access-Control-Allow-Methods".to_owned(),
        "GET, HEAD, OPTIONS".to_owned(),
    ));
    headers.push((
        "Access-Control-Allow-Headers".to_owned(),
        "Range, If-None-Match".to_owned(),
    ));
    headers.push(("Content-Length".to_owned(), "0".to_owned()));
    ServeResponse {
        status: 204,
        headers,
        body: Vec::new(),
    }
}

/// 状態だけの短い応答。内部のパスや他のデータを含まない。
pub fn error_response(status: u16) -> ServeResponse {
    let body = reason(status).as_bytes().to_vec();
    let mut headers = common_headers();
    headers.push((
        "Content-Type".to_owned(),
        "text/plain; charset=utf-8".to_owned(),
    ));
    headers.push(("Content-Length".to_owned(), body.len().to_string()));
    ServeResponse {
        status,
        headers,
        body,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResponseLimits {
    /// 1 回の Range 応答の大きさ。
    pub chunk: u64,
    /// Range なしで返せるファイルの大きさ。
    pub full: u64,
}

impl Default for ResponseLimits {
    fn default() -> Self {
        Self {
            chunk: RANGE_CHUNK,
            full: FULL_LIMIT,
        }
    }
}

pub struct ResponseContext<'a> {
    pub head: bool,
    pub range: Option<&'a str>,
    pub if_none_match: Option<&'a str>,
    pub content_type: &'a str,
    /// `ETag`（サイズと更新時刻）を付け、`If-None-Match` に応えるか。
    pub etag: bool,
    pub extra_headers: Vec<(String, String)>,
    pub limits: ResponseLimits,
    pub budget: Option<&'a Budget>,
}

impl<'a> ResponseContext<'a> {
    pub fn new(content_type: &'a str) -> Self {
        Self {
            head: false,
            range: None,
            if_none_match: None,
            content_type,
            etag: false,
            extra_headers: Vec::new(),
            limits: ResponseLimits::default(),
            budget: None,
        }
    }
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(0)
}

fn etag_matches(header: &str, etag: &str) -> bool {
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.trim_start_matches("W/") == etag
    })
}

/// ファイルを、Range・ETag・上限・予算に従って返す。ファイルの全体は読まない（必要な範囲だけ）。
pub fn respond_file(path: &Path, ctx: &ResponseContext<'_>) -> ServeResponse {
    // フォルダは、ファイルとして返さない。開く前に調べる（Windows では、フォルダを開くと「アクセス拒否」になり、404 にならない）
    if std::fs::metadata(path).is_ok_and(|m| m.is_dir()) {
        return ServeError::NotFound.to_response();
    }
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return ServeError::NotFound.to_response();
        }
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            return ServeError::Forbidden.to_response();
        }
        Err(_) => return ServeError::Internal.to_response(),
    };
    let Ok(meta) = file.metadata() else {
        return ServeError::Internal.to_response();
    };
    if !meta.is_file() {
        return ServeError::NotFound.to_response();
    }
    let len = meta.len();
    let etag = ctx.etag.then(|| format!("\"{len}-{}\"", mtime_ms(&meta)));

    let mut headers = common_headers();
    headers.push(("Cache-Control".to_owned(), "no-cache".to_owned()));
    if let Some(etag) = &etag {
        headers.push(("ETag".to_owned(), etag.clone()));
        if ctx
            .if_none_match
            .is_some_and(|header| etag_matches(header, etag))
        {
            return ServeResponse {
                status: 304,
                headers,
                body: Vec::new(),
            };
        }
    }
    headers.extend(ctx.extra_headers.iter().cloned());

    let (status, start, end) = match parse_range(ctx.range, len) {
        RangeOutcome::Unsatisfiable => {
            let mut response = error_response(416);
            response
                .headers
                .push(("Content-Range".to_owned(), format!("bytes */{len}")));
            return response;
        }
        RangeOutcome::Full => {
            if len > ctx.limits.full {
                return ServeError::TooLarge.to_response();
            }
            (200, 0, len.saturating_sub(1))
        }
        RangeOutcome::Partial { start, end } => {
            let capped = end.min(start.saturating_add(ctx.limits.chunk.saturating_sub(1)));
            (206, start, capped)
        }
    };
    let count = if len == 0 { 0 } else { end - start + 1 };

    let _permit = match (ctx.budget, count) {
        (Some(budget), n) if n > 0 => match budget.acquire(n, BUDGET_WAIT) {
            Ok(permit) => Some(permit),
            Err(e) => return e.to_response(),
        },
        _ => None,
    };

    let mut body = Vec::new();
    if !ctx.head && count > 0 {
        if file.seek(SeekFrom::Start(start)).is_err() {
            return ServeError::Internal.to_response();
        }
        body.reserve(usize::try_from(count).unwrap_or(0));
        if file.take(count).read_to_end(&mut body).is_err() || body.len() as u64 != count {
            // 配信中にファイルが縮んだ・読めなくなった
            return ServeError::Internal.to_response();
        }
    }

    headers.push(("Content-Type".to_owned(), ctx.content_type.to_owned()));
    headers.push(("Content-Length".to_owned(), count.to_string()));
    headers.push(("Accept-Ranges".to_owned(), "bytes".to_owned()));
    if status == 206 {
        headers.push((
            "Content-Range".to_owned(),
            format!("bytes {start}-{end}/{len}"),
        ));
    }
    ServeResponse {
        status,
        headers,
        body,
    }
}

// ---- アセットの実パス ----

/// 配信のために解決したアセットの場所。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetFile {
    /// ルート（プロジェクトのフォルダ、または外部ルートのフォルダ）。
    pub root: PathBuf,
    /// ルートからの相対パス（区切りは `/`）。
    pub rel_path: String,
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Error)]
pub enum AssetFileError {
    /// 登録が無い・リンク切れ・ルートが見つからない。
    #[error("アセットが見つかりません")]
    NotFound,
    #[error(transparent)]
    Store(#[from] StoreError),
}
