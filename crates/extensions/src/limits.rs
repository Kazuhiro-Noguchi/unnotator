//! `.unnoplugin` の取り込みの上限。定数はここだけに置く（research.md R1）。

/// 1 つのパッケージに入るエントリ（ファイル・フォルダ）の数。
pub const MAX_ENTRIES: usize = 5_000;
/// 1 つのファイルの、展開後の大きさ（バイト）。
pub const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
/// 展開後の合計の大きさ（バイト）。
pub const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// 圧縮率（展開後 ÷ 圧縮後）の上限。
pub const MAX_RATIO: u64 = 200;
/// この大きさまでの展開は、圧縮率を見ない（小さなファイルは率が大きくなりやすい）。
pub const RATIO_FLOOR_BYTES: u64 = 1024 * 1024;
/// 1 つのパス（エントリの名前）の長さ（バイト）。
pub const MAX_PATH_BYTES: usize = 1_024;
/// パスの 1 つの成分の長さ（バイト）。
pub const MAX_COMPONENT_BYTES: usize = 255;
