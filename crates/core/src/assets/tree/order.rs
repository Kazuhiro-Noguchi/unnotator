//! 名前の畳み込みと自然順の比較（純関数）。
//!
//! 畳み込み: 小文字化と、全角の英数記号・全角空白の半角化（`research.md` R2）。
//! かなの同一視や結合文字の正規化はしない。

use std::cmp::Ordering;

/// 比べる・探すための畳み込み。
pub fn fold(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(u32::from(c) - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .flat_map(char::to_lowercase)
        .collect()
}

/// 比べるときの 1 つの単位。数字の連なりは 1 つにまとめ、どの文字よりも前に置く。
#[derive(Debug, PartialEq, Eq)]
enum Token<'a> {
    /// 先頭の 0 を除いた数字の連なり（桁数が大きいほど大きい）。
    Number(&'a str),
    Char(char),
}

impl Ord for Token<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Number(a), Self::Number(b)) => a.len().cmp(&b.len()).then_with(|| a.cmp(b)),
            (Self::Number(_), Self::Char(_)) => Ordering::Less,
            (Self::Char(_), Self::Number(_)) => Ordering::Greater,
            (Self::Char(a), Self::Char(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for Token<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn tokens(text: &str) -> impl Iterator<Item = Token<'_>> {
    let mut rest = text;
    std::iter::from_fn(move || {
        let first = rest.chars().next()?;
        if first.is_ascii_digit() {
            let end = rest
                .find(|c: char| !c.is_ascii_digit())
                .unwrap_or(rest.len());
            let (run, tail) = rest.split_at(end);
            rest = tail;
            Some(Token::Number(run.trim_start_matches('0')))
        } else {
            rest = &rest[first.len_utf8()..];
            Some(Token::Char(first))
        }
    })
}

/// 自然順の比較。畳み込んだ名前で数字の連なりを数として比べ、同じなら元の文字列で決める（全順序）。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (fa, fb) = (fold(a), fold(b));
    tokens(&fa).cmp(tokens(&fb)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut v: Vec<String> = names.iter().map(|s| (*s).to_owned()).collect();
        v.sort_by(|a, b| natural_cmp(a, b));
        v
    }

    #[test]
    fn fold_lowercases_and_halves_width() {
        assert_eq!(fold("IMG"), "img");
        assert_eq!(fold("ＩＭＧ１"), "img1");
        assert_eq!(fold("ａ　ｂ"), "a b");
        assert_eq!(fold("！～"), "!~");
        assert_eq!(fold("メモ"), "メモ");
    }

    #[test]
    fn digits_compare_as_numbers() {
        assert_eq!(
            sorted(&["img10", "img2", "img1"]),
            ["img1", "img2", "img10"]
        );
        assert_eq!(natural_cmp("a2", "a10"), Ordering::Less);
        assert_eq!(natural_cmp("a10", "a2"), Ordering::Greater);
    }

    #[test]
    fn leading_zeros_do_not_change_the_numeric_order() {
        assert_eq!(sorted(&["a02", "a1", "a003"]), ["a1", "a02", "a003"]);
    }

    #[test]
    fn case_and_width_are_ignored_first_then_the_original_decides() {
        assert_eq!(sorted(&["b", "A", "a", "B"]), ["A", "a", "B", "b"]);
        assert_ne!(natural_cmp("ａ", "a"), Ordering::Equal);
        assert_eq!(sorted(&["ａ2", "a10"]), ["ａ2", "a10"]);
    }

    #[test]
    fn it_is_a_total_order_and_stable_across_runs() {
        let names = [
            "メモ",
            "メモ2",
            "メモ10",
            "IMG",
            "img",
            "Img",
            "ＩＭＧ",
            "1",
            "01",
            "001",
            "a b",
            "a_b",
            "",
            "日本語",
            "日本語2",
            "~x",
            "!y",
        ];
        for a in names {
            assert_eq!(natural_cmp(a, a), Ordering::Equal);
            for b in names {
                assert_eq!(natural_cmp(a, b), natural_cmp(b, a).reverse(), "{a} {b}");
                if natural_cmp(a, b) == Ordering::Equal {
                    assert_eq!(a, b);
                }
                for c in names {
                    if natural_cmp(a, b) != Ordering::Greater
                        && natural_cmp(b, c) != Ordering::Greater
                    {
                        assert_ne!(natural_cmp(a, c), Ordering::Greater, "{a} {b} {c}");
                    }
                }
            }
        }
        assert_eq!(
            sorted(&names),
            sorted(&{
                let mut r = names;
                r.reverse();
                r
            })
        );
    }

    #[test]
    fn very_long_digit_runs_do_not_overflow() {
        let big = "9".repeat(60);
        let bigger = format!("{big}0");
        assert_eq!(
            natural_cmp(&format!("x{big}"), &format!("x{bigger}")),
            Ordering::Less
        );
    }
}
