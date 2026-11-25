//! `Range: bytes=...` の解釈。単一の範囲だけに対応する。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeOutcome {
    /// `Range` なし（または知らない単位）。全体。
    Full,
    /// 両端を含む範囲（長さに丸めてある）。
    Partial { start: u64, end: u64 },
    /// 範囲が外れる・不正・複数。416 にする。
    Unsatisfiable,
}

pub fn parse_range(header: Option<&str>, len: u64) -> RangeOutcome {
    let Some(header) = header else {
        return RangeOutcome::Full;
    };
    let Some(spec) = header.trim().strip_prefix("bytes=") else {
        return RangeOutcome::Full;
    };
    if len == 0 || spec.contains(',') {
        return RangeOutcome::Unsatisfiable;
    }
    let Some((first, last)) = spec.trim().split_once('-') else {
        return RangeOutcome::Unsatisfiable;
    };
    let (first, last) = (first.trim(), last.trim());
    let number = |text: &str| -> Option<u64> {
        (!text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()))
            .then(|| text.parse::<u64>().unwrap_or(u64::MAX))
    };
    match (number(first), number(last)) {
        // bytes=a-b / bytes=a-
        (Some(start), end) => {
            if start >= len || end.is_some_and(|end| end < start) {
                return RangeOutcome::Unsatisfiable;
            }
            RangeOutcome::Partial {
                start,
                end: end.map_or(len - 1, |end| end.min(len - 1)),
            }
        }
        // bytes=-n（末尾の n バイト）
        (None, Some(suffix)) if first.is_empty() => {
            if suffix == 0 {
                return RangeOutcome::Unsatisfiable;
            }
            RangeOutcome::Partial {
                start: len.saturating_sub(suffix),
                end: len - 1,
            }
        }
        _ => RangeOutcome::Unsatisfiable,
    }
}
