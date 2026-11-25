//! バイト予算: 配信中の本体の合計と、同時に配信する要求の数を制限する。

use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use super::ServeError;

pub struct Budget {
    total: u64,
    max_concurrent: usize,
    state: Mutex<State>,
    freed: Condvar,
}

#[derive(Default)]
struct State {
    used: u64,
    active: usize,
}

/// 確保した分。破棄すると返る。
pub struct Permit<'a> {
    budget: &'a Budget,
    bytes: u64,
}

impl Budget {
    pub fn new(total: u64, max_concurrent: usize) -> Self {
        Self {
            total,
            max_concurrent,
            state: Mutex::new(State::default()),
            freed: Condvar::new(),
        }
    }

    /// `bytes` を確保する。予算や同時数が空くまで、`timeout` まで待つ。
    /// 1 件で合計を超えるなら `TooLarge`、時間切れなら `Busy`。
    pub fn acquire(&self, bytes: u64, timeout: Duration) -> Result<Permit<'_>, ServeError> {
        if bytes > self.total {
            return Err(ServeError::TooLarge);
        }
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().map_err(|_| ServeError::Internal)?;
        loop {
            if state.active < self.max_concurrent && state.used + bytes <= self.total {
                state.used += bytes;
                state.active += 1;
                return Ok(Permit {
                    budget: self,
                    bytes,
                });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(ServeError::Busy);
            }
            let (next, _) = self
                .freed
                .wait_timeout(state, deadline - now)
                .map_err(|_| ServeError::Internal)?;
            state = next;
        }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if let Ok(mut state) = self.budget.state.lock() {
            state.used = state.used.saturating_sub(self.bytes);
            state.active = state.active.saturating_sub(1);
        }
        self.budget.freed.notify_all();
    }
}
