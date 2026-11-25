//! 時刻の取得。テストで差し替えられるようにする。

use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// UNIX エポックからのミリ秒を返す。
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// 実際の時刻。
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    }
}

/// テスト用。値を手で決める。
#[derive(Debug, Default)]
pub struct ManualClock(AtomicI64);

impl ManualClock {
    pub fn new(ms: i64) -> Self {
        Self(AtomicI64::new(ms))
    }

    pub fn set(&self, ms: i64) {
        self.0.store(ms, Ordering::SeqCst);
    }

    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_clock_returns_plausible_epoch_millis() {
        // 2020-01-01 より後
        assert!(SystemClock.now_ms() > 1_577_836_800_000);
    }

    #[test]
    fn manual_clock_can_be_set_and_advanced() {
        let clock = ManualClock::new(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(5);
        assert_eq!(clock.now_ms(), 1_005);
        clock.set(42);
        assert_eq!(clock.now_ms(), 42);
    }
}
