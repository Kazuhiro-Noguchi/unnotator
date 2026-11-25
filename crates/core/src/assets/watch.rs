//! 見張り（research.md R6）。変わった可能性があるパスを、短い時間にまとめて部分走査へ渡す。
//!
//! 通知（`notify`）の実装は、依存の承認が出てから足す。それまでは `PollingWatcher`（通知なしで動く定期走査）が代わる。
//! どちらも「変わったかもしれない場所」を報せるだけで、最終的な正は走査（FR-023）。

use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::exclude::ExcludeSet;
use super::scan::{ScanPath, ScanScope};

/// まとめた変化。`overflow` のときは、個々のパスを諦めて、全体を走査する。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WatchBatch {
    pub paths: Vec<ScanPath>,
    pub overflow: bool,
}

impl WatchBatch {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && !self.overflow
    }

    /// 走査の範囲。
    pub fn scope(&self) -> ScanScope {
        if self.overflow {
            ScanScope::Full
        } else {
            ScanScope::Paths(self.paths.clone())
        }
    }
}

/// 変わった場所を報せる部品。呼ぶたびに、前回から変わった分を返す（なければ空）。
pub trait Watcher: Send {
    fn tick(&mut self) -> WatchBatch;
}

/// 短い時間の多数の変化を 1 つにまとめる。
pub struct Debouncer {
    window: Duration,
    max_wait: Duration,
    max_paths: usize,
    pending: BTreeSet<(String, String)>,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl Debouncer {
    /// `window`: 静かになるまでの待ち。`max_wait`: 絶え間なく続くときの最長の待ち。`max_paths`: これを超えたら全体の走査にする。
    pub fn new(window: Duration, max_wait: Duration, max_paths: usize) -> Self {
        Self {
            window,
            max_wait,
            max_paths,
            pending: BTreeSet::new(),
            first: None,
            last: None,
        }
    }

    pub fn push(&mut self, root_key: &str, rel_path: &str, now: Instant) {
        self.pending
            .insert((root_key.to_owned(), rel_path.to_owned()));
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    /// 出せるなら取り出す。静かになってから `window` が過ぎたか、最初の変化から `max_wait` が過ぎたとき。
    pub fn ready(&mut self, now: Instant) -> Option<WatchBatch> {
        let (first, last) = (self.first?, self.last?);
        if now.duration_since(last) < self.window && now.duration_since(first) < self.max_wait {
            return None;
        }
        let pending = std::mem::take(&mut self.pending);
        self.first = None;
        self.last = None;
        if pending.len() > self.max_paths {
            return Some(WatchBatch {
                paths: Vec::new(),
                overflow: true,
            });
        }
        Some(WatchBatch {
            paths: collapse(pending),
            overflow: false,
        })
    }
}

/// フォルダがあれば、その下のパスは省く。
fn collapse(paths: BTreeSet<(String, String)>) -> Vec<ScanPath> {
    let mut kept: Vec<(String, String)> = Vec::new();
    for (root, rel) in paths {
        let covered = kept.iter().any(|(r, k)| {
            *r == root && (k.is_empty() || rel == *k || rel.starts_with(&format!("{k}/")))
        });
        if !covered {
            kept.push((root, rel));
        }
    }
    kept.into_iter()
        .map(|(root_key, rel_path)| ScanPath { root_key, rel_path })
        .collect()
}

/// 通知なしで動く見張り。フォルダの更新時刻の変化から、変わったフォルダを報せる。
/// ファイルの中身だけが書き換わってもフォルダの更新時刻は変わらないので、`full_every` 回に 1 回、全体の走査を求める。
pub struct PollingWatcher {
    roots: Vec<(String, PathBuf)>,
    exclude: ExcludeSet,
    full_every: u32,
    known: Option<HashMap<(String, String), i64>>,
    count: u32,
}

impl PollingWatcher {
    pub fn new(roots: Vec<(String, PathBuf)>, exclude: ExcludeSet, full_every: u32) -> Self {
        Self {
            roots,
            exclude,
            full_every: full_every.max(1),
            known: None,
            count: 0,
        }
    }

    /// フォルダ（除外を除く）の更新時刻を集める。
    fn snapshot(&self) -> HashMap<(String, String), i64> {
        let mut out = HashMap::new();
        for (key, root) in &self.roots {
            let mut stack = vec![String::new()];
            while let Some(rel) = stack.pop() {
                let abs = if rel.is_empty() {
                    root.clone()
                } else {
                    root.join(&rel)
                };
                let Ok(meta) = std::fs::symlink_metadata(&abs) else {
                    continue;
                };
                if !meta.is_dir() {
                    continue;
                }
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .and_then(|d| i64::try_from(d.as_nanos()).ok())
                    .unwrap_or(0);
                out.insert((key.clone(), rel.clone()), mtime);
                let Ok(entries) = std::fs::read_dir(&abs) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let Ok(file_type) = entry.file_type() else {
                        continue;
                    };
                    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                        continue;
                    };
                    let child = if rel.is_empty() {
                        name
                    } else {
                        format!("{rel}/{name}")
                    };
                    if file_type.is_dir() && !self.exclude.is_excluded(&child, true) {
                        stack.push(child);
                    }
                }
            }
        }
        out
    }
}

impl Watcher for PollingWatcher {
    fn tick(&mut self) -> WatchBatch {
        self.count = self.count.saturating_add(1);
        let now = self.snapshot();
        let Some(before) = self.known.replace(now.clone()) else {
            return WatchBatch::default(); // 最初は基準を覚えるだけ
        };
        if self.count.is_multiple_of(self.full_every) {
            return WatchBatch {
                paths: Vec::new(),
                overflow: true,
            };
        }
        let mut changed: BTreeSet<(String, String)> = BTreeSet::new();
        for (key, mtime) in &now {
            if before.get(key) != Some(mtime) {
                changed.insert(key.clone());
            }
        }
        for key in before.keys() {
            if !now.contains_key(key) {
                changed.insert(key.clone());
            }
        }
        WatchBatch {
            paths: collapse(changed),
            overflow: false,
        }
    }
}

/// 数回に 1 回だけ、中身の見張りを進める。定期走査（`PollingWatcher`）を、短い間隔の呼び出しの上で間引くために使う。
pub struct Throttled<W> {
    inner: W,
    every: u32,
    calls: u32,
}

impl<W: Watcher> Throttled<W> {
    pub fn new(inner: W, every: u32) -> Self {
        Self {
            inner,
            every: every.max(1),
            calls: 0,
        }
    }
}

impl<W: Watcher> Watcher for Throttled<W> {
    fn tick(&mut self) -> WatchBatch {
        self.calls = self.calls.saturating_add(1);
        if self.calls.is_multiple_of(self.every) {
            self.inner.tick()
        } else {
            WatchBatch::default()
        }
    }
}

/// OS のファイルシステムの通知（`notify`）を使う見張り。通知は `Debouncer` でまとめる。
/// 取りこぼすことがあるので、`full_every` 回に 1 回、全体の走査を求める（FR-023）。
pub struct NotifyWatcher {
    // 持っている間だけ、通知が届く
    _watchers: Vec<notify::RecommendedWatcher>,
    events: std::sync::mpsc::Receiver<(String, PathBuf)>,
    roots: Vec<(String, PathBuf)>,
    exclude: ExcludeSet,
    debouncer: Debouncer,
    full_every: u32,
    calls: u32,
}

impl NotifyWatcher {
    /// ルートごとに通知を登録する。登録できないルートがあれば、`Err`（呼び出し側は定期走査へ切り替える）。
    pub fn new(
        roots: Vec<(String, PathBuf)>,
        exclude: ExcludeSet,
        full_every: u32,
    ) -> Result<Self, notify::Error> {
        use notify::{RecursiveMode, Watcher as _};
        let (sender, events) = std::sync::mpsc::channel();
        let mut watchers = Vec::new();
        for (key, root) in &roots {
            let key = key.clone();
            let sender = sender.clone();
            let mut watcher = notify::recommended_watcher(
                move |result: Result<notify::Event, notify::Error>| {
                    let Ok(event) = result else {
                        return;
                    };
                    // 読み取りだけの通知は、変化ではない
                    if matches!(event.kind, notify::EventKind::Access(_)) {
                        return;
                    }
                    for path in event.paths {
                        let _ = sender.send((key.clone(), path));
                    }
                },
            )?;
            watcher.watch(root, RecursiveMode::Recursive)?;
            watchers.push(watcher);
        }
        Ok(Self {
            _watchers: watchers,
            events,
            roots,
            exclude,
            debouncer: Debouncer::new(Duration::from_millis(500), Duration::from_secs(2), 2_000),
            full_every: full_every.max(1),
            calls: 0,
        })
    }

    fn relative(&self, key: &str, path: &std::path::Path) -> Option<String> {
        let root = &self.roots.iter().find(|(k, _)| k == key)?.1;
        // 通知のパスは、実体のパス（シンボリックリンクを解決したもの）で届くことがある
        let canonical_root = std::fs::canonicalize(root).ok();
        let rel = path
            .strip_prefix(root)
            .ok()
            .or_else(|| path.strip_prefix(canonical_root.as_deref()?).ok())?;
        let rel = rel
            .components()
            .map(|c| c.as_os_str().to_str())
            .collect::<Option<Vec<_>>>()?
            .join("/");
        Some(rel)
    }
}

impl Watcher for NotifyWatcher {
    fn tick(&mut self) -> WatchBatch {
        self.calls = self.calls.saturating_add(1);
        let now = Instant::now();
        while let Ok((key, path)) = self.events.try_recv() {
            let Some(rel) = self.relative(&key, &path) else {
                continue;
            };
            // ルート自身の変化は、全体を走査するのと同じ。除外されたもの（と、`.unnotator/`）は無視する
            if !rel.is_empty() && self.exclude.is_excluded(&rel, false) {
                continue;
            }
            self.debouncer.push(&key, &rel, now);
        }
        if self.calls.is_multiple_of(self.full_every) {
            return WatchBatch {
                paths: Vec::new(),
                overflow: true,
            };
        }
        self.debouncer.ready(now).unwrap_or_default()
    }
}
