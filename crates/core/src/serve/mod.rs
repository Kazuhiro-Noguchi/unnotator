//! `unno://` の配信の本体（Tauri 非依存）。URL の解釈・パスの閉じ込め・Range・バイト予算・ブロブ。

pub mod blob;
pub mod budget;
pub mod confine;
pub mod mime;
pub mod range;
pub mod url;
