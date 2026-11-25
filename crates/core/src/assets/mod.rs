//! アセット（プロジェクトのフォルダや外部ルートの下のファイル）の走査・除外・判定規則・再接続・見張り。
//!
//! 媒体に関係しない（憲章 I）。媒体種別の判定規則は外から渡される値で、コアは表を持たない。

pub mod exclude;
pub mod media;
pub mod path;
pub mod relink;
pub mod scan;
pub mod watch;
