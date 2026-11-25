//! unnotator-worker

/// ワーカーのプロトコル（TypeScript の型定義）。契約の正本をそのまま埋め込む。
pub const PROTOCOL_TS: &str = include_str!("../protocol/protocol.ts");

#[cfg(test)]
mod tests {
    use super::PROTOCOL_TS;

    #[test]
    fn protocol_ts_declares_version_1() {
        assert!(PROTOCOL_TS.contains("PROTOCOL_VERSION = 1"));
    }
}
