//! ID（UUID v7）の生成。
//!
//! 上位 48 ビットはミリ秒の時刻、続く 12 ビットは同じミリ秒内の連番、残りは SQLite の `randomblob`
//! から取った乱数（research.md R2）。契約の規約（小文字・ハイフン付き）に従う。

use rusqlite::Connection;

use crate::error::StoreError;

pub trait IdGenerator: Send {
    /// 新しい ID を返す。乱数は `conn`（SQLite の `randomblob`）から取る。
    fn next_id(&mut self, conn: &Connection, now_ms: i64) -> Result<String, StoreError>;
}

/// UUID v7 を作る。同じミリ秒内でも単調に増える。
#[derive(Debug, Default)]
pub struct UuidV7Generator {
    last_ms: u64,
    counter: u16,
}

impl IdGenerator for UuidV7Generator {
    fn next_id(&mut self, conn: &Connection, now_ms: i64) -> Result<String, StoreError> {
        let now = u64::try_from(now_ms).unwrap_or(0);
        let mut ms = now.max(self.last_ms);
        if ms == self.last_ms && self.last_ms != 0 {
            self.counter += 1;
            if self.counter > 0x0FFF {
                // 同じミリ秒で 4096 個を超えたら、時刻を 1 ミリ秒進める。
                ms += 1;
                self.counter = 0;
            }
        } else {
            self.counter = 0;
        }
        self.last_ms = ms;

        let random: Vec<u8> = conn.query_row("SELECT randomblob(8)", [], |row| row.get(0))?;
        let mut bytes = [0u8; 16];
        bytes[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
        bytes[6] = 0x70 | u8::try_from(self.counter >> 8).unwrap_or(0);
        bytes[7] = u8::try_from(self.counter & 0xFF).unwrap_or(0);
        for (slot, value) in bytes[8..].iter_mut().zip(random.iter()) {
            *slot = *value;
        }
        bytes[8] = 0x80 | (bytes[8] & 0x3F);
        Ok(format_uuid(&bytes))
    }
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// テスト用。決まった順序の ID を返す。
#[derive(Debug, Default)]
pub struct SequentialIds {
    next: u64,
}

impl SequentialIds {
    /// `n` の次の番号から始める。開き直しても前の ID と重ならないようにするため。
    pub fn starting_after(n: u64) -> Self {
        Self { next: n }
    }
}

impl IdGenerator for SequentialIds {
    fn next_id(&mut self, _conn: &Connection, _now_ms: i64) -> Result<String, StoreError> {
        self.next += 1;
        Ok(format!("00000000-0000-7000-8000-{:012x}", self.next))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn is_uuid_v7(id: &str) -> bool {
        let b = id.as_bytes();
        id.len() == 36
            && [8, 13, 18, 23].iter().all(|&i| b[i] == b'-')
            && id
                .chars()
                .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c))
            && b[14] == b'7'
            && matches!(b[19], b'8' | b'9' | b'a' | b'b')
    }

    #[test]
    fn generated_ids_have_uuid_v7_format() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ids = UuidV7Generator::default();
        let id = ids.next_id(&conn, 1_700_000_000_000).unwrap();
        assert!(is_uuid_v7(&id), "{id}");
        // 上位 48 ビットは時刻（ミリ秒）
        assert!(id.starts_with("018b"), "{id}");
    }

    #[test]
    fn ids_are_strictly_increasing_even_within_one_millisecond() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ids = UuidV7Generator::default();
        let mut previous = String::new();
        for _ in 0..5_000 {
            let id = ids.next_id(&conn, 1_700_000_000_000).unwrap();
            assert!(id > previous, "{id} <= {previous}");
            previous = id;
        }
    }

    #[test]
    fn ids_are_unique_across_generators() {
        let conn = Connection::open_in_memory().unwrap();
        let a = UuidV7Generator::default()
            .next_id(&conn, 1_700_000_000_000)
            .unwrap();
        let b = UuidV7Generator::default()
            .next_id(&conn, 1_700_000_000_000)
            .unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn sequential_ids_are_deterministic() {
        let conn = Connection::open_in_memory().unwrap();
        let mut ids = SequentialIds::default();
        assert_eq!(
            ids.next_id(&conn, 0).unwrap(),
            "00000000-0000-7000-8000-000000000001"
        );
        assert_eq!(
            ids.next_id(&conn, 0).unwrap(),
            "00000000-0000-7000-8000-000000000002"
        );
    }
}
