//! 読み取り専用の問い合わせ（008）。DB を変えない。書き込みは `command/` と `apply_command` だけ。
//!
//! 媒体に関係しない（憲章 I）。`selector_json` は返さない。
