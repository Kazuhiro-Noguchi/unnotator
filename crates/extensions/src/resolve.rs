//! 依存の解決: 版の選択・連鎖・循環・有効化の順番（research.md R4）。
//!
//! 同じ ID は、1 つの版だけを有効にする。版は「全ての依存する側の範囲を満たす、最も新しいもの」を選ぶ。
//! 欠落・版の不一致・循環・アプリの拡張 API の版の不一致・利用者が無効にした依存先は、理由つきで落とす（連鎖する）。
//! 結果は、入力の並びに依らず決まる（同じ段は ID の昇順）。

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use unnotator_core::extensions_list::{compare_versions, version_satisfies};

/// 検討する 1 つの版。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub id: String,
    pub version: String,
    /// `engines.unnotator`。
    pub engine_range: String,
    /// `extensionDependencies`（ID → 版の範囲）。
    pub dependencies: BTreeMap<String, String>,
}

/// 有効にならない理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// 利用者が無効にした。
    UserDisabled,
    PinnedVersionMissing {
        pinned: String,
        installed: Vec<String>,
    },
    Engine {
        required: String,
        app: String,
    },
    MissingDependency {
        dependency: String,
        required: String,
    },
    DependencyVersion {
        dependency: String,
        required: String,
        installed: Vec<String>,
    },
    /// 依存先を、利用者が（または連鎖して）無効にしている。
    DependencyDisabled {
        dependency: String,
    },
    /// 依存先に問題があって、有効にならない。
    DependencyInvalid {
        dependency: String,
    },
    /// 依存の輪。`path` は、最初の ID で閉じる経路（`a → b → a`）。
    Cycle {
        path: Vec<String>,
    },
}

impl Reason {
    /// 利用者の選択（または、その連鎖）で、問題ではないもの。
    pub fn is_user_choice(&self) -> bool {
        matches!(
            self,
            Reason::UserDisabled | Reason::DependencyDisabled { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Resolution {
    /// 有効にする（ID, 版）。有効化の順（依存先が先）。
    pub chosen: Vec<(String, String)>,
    /// 有効にならない ID → （代表の版、理由）。代表の版は、入っている中で最も新しいもの。
    pub rejected: BTreeMap<String, (String, Reason)>,
}

/// 版を、新しい順に並べる（読めない版は、文字列の順で最後に）。
pub fn newest_first(versions: &mut [String]) {
    versions.sort_by(|a, b| version_order(b, a));
}

fn version_order(a: &str, b: &str) -> Ordering {
    match (compare_versions(a, b), parsable(a), parsable(b)) {
        (Some(order), _, _) => order,
        (None, true, false) => Ordering::Greater,
        (None, false, true) => Ordering::Less,
        _ => a.cmp(b),
    }
}

fn parsable(version: &str) -> bool {
    compare_versions(version, version).is_some()
}

const MAX_ROUNDS: usize = 64;

pub fn resolve(
    candidates: &[Candidate],
    disabled: &BTreeSet<String>,
    pins: &BTreeMap<String, String>,
    app_api_version: &str,
) -> Resolution {
    // ID → 版（新しい順）→ 候補
    let mut by_id: BTreeMap<&str, Vec<&Candidate>> = BTreeMap::new();
    for c in candidates {
        by_id.entry(c.id.as_str()).or_default().push(c);
    }
    for list in by_id.values_mut() {
        list.sort_by(|a, b| version_order(&b.version, &a.version));
    }

    // 版ごとの落ちた理由
    let mut dead: BTreeMap<(&str, &str), Reason> = BTreeMap::new();
    for (id, list) in &by_id {
        for c in list {
            if disabled.contains(*id) {
                dead.insert((id, c.version.as_str()), Reason::UserDisabled);
            } else if let Some(pin) = pins.get(*id).filter(|pin| **pin != c.version) {
                dead.insert(
                    (id, c.version.as_str()),
                    Reason::PinnedVersionMissing {
                        pinned: pin.clone(),
                        installed: list.iter().map(|c| c.version.clone()).collect(),
                    },
                );
            }
            if !dead.contains_key(&(*id, c.version.as_str()))
                && version_satisfies(&c.engine_range, app_api_version) != Some(true)
            {
                dead.insert(
                    (id, c.version.as_str()),
                    Reason::Engine {
                        required: c.engine_range.clone(),
                        app: app_api_version.to_owned(),
                    },
                );
            }
        }
    }
    let alive_versions = |id: &str, dead: &BTreeMap<(&str, &str), Reason>| -> Vec<&Candidate> {
        by_id
            .get(id)
            .map(|list| {
                list.iter()
                    .copied()
                    .filter(|c| !dead.contains_key(&(c.id.as_str(), c.version.as_str())))
                    .collect()
            })
            .unwrap_or_default()
    };

    for _round in 0..MAX_ROUNDS {
        let mut changed = false;

        // 1. 各 ID の、全ての依存する側の範囲を満たす最新の版を選ぶ
        let chosen = choose_versions(&by_id, &dead);

        // 2. 依存を検査する
        let mut kills: Vec<((&str, &str), Reason)> = Vec::new();
        for (id, version) in &chosen {
            let candidate = by_id[id]
                .iter()
                .find(|c| c.version == *version)
                .expect("選んだ版は候補にある");
            for (dep, range) in &candidate.dependencies {
                let reason = if !by_id.contains_key(dep.as_str()) {
                    Some(Reason::MissingDependency {
                        dependency: dep.clone(),
                        required: range.clone(),
                    })
                } else if disabled.contains(dep) {
                    Some(Reason::DependencyDisabled {
                        dependency: dep.clone(),
                    })
                } else if alive_versions(dep, &dead).is_empty() {
                    Some(dependency_gone(dep, &by_id, &dead))
                } else {
                    match chosen.get(dep.as_str()) {
                        Some(v) if version_satisfies(range, v) == Some(true) => None,
                        // どの版も、依存する側の範囲をすべては満たせない
                        _ => Some(Reason::DependencyVersion {
                            dependency: dep.clone(),
                            required: range.clone(),
                            installed: alive_versions(dep, &dead)
                                .iter()
                                .map(|c| c.version.clone())
                                .collect(),
                        }),
                    }
                };
                if let Some(reason) = reason {
                    kills.push(((candidate.id.as_str(), candidate.version.as_str()), reason));
                    break;
                }
            }
        }
        for (key, reason) in kills {
            if let std::collections::btree_map::Entry::Vacant(slot) = dead.entry(key) {
                slot.insert(reason);
                changed = true;
            }
        }
        if changed {
            continue;
        }

        // 3. 輪を探す（選んだ版どうしの辺）
        let cycles = find_cycles(&chosen, &by_id);
        for (members, path) in cycles {
            for id in members {
                if let Some(version) = chosen.get(id.as_str()) {
                    let key = (
                        by_id
                            .get_key_value(id.as_str())
                            .map(|(k, _)| *k)
                            .expect("ID がある"),
                        by_id[id.as_str()]
                            .iter()
                            .find(|c| &c.version == version)
                            .map(|c| c.version.as_str())
                            .expect("版がある"),
                    );
                    dead.insert(key, Reason::Cycle { path: path.clone() });
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }

    // 結果
    let chosen = choose_versions(&by_id, &dead);
    let mut resolution = Resolution::default();
    for (id, list) in &by_id {
        if chosen.contains_key(*id) {
            continue;
        }
        // 入っている中で最も新しい版の理由を、代表にする
        let newest = list[0];
        let reason = dead
            .get(&(*id, newest.version.as_str()))
            .cloned()
            .unwrap_or(Reason::UserDisabled);
        resolution
            .rejected
            .insert((*id).to_owned(), (newest.version.clone(), reason));
    }
    resolution.chosen = activation_order(&chosen, &by_id);
    resolution
}

/// 依存先のすべての版が落ちているときの理由（利用者の選択の連鎖か、問題か）。
fn dependency_gone(
    dep: &str,
    by_id: &BTreeMap<&str, Vec<&Candidate>>,
    dead: &BTreeMap<(&str, &str), Reason>,
) -> Reason {
    let newest = by_id[dep][0];
    match dead.get(&(dep, newest.version.as_str())) {
        Some(reason) if reason.is_user_choice() => Reason::DependencyDisabled {
            dependency: dep.to_owned(),
        },
        _ => Reason::DependencyInvalid {
            dependency: dep.to_owned(),
        },
    }
}

/// ID ごとに、生きている版のうち、生きている依存する側（その ID の最新の生きた版）の範囲をすべて満たす最新のものを選ぶ。
fn choose_versions<'a>(
    by_id: &BTreeMap<&'a str, Vec<&'a Candidate>>,
    dead: &BTreeMap<(&'a str, &'a str), Reason>,
) -> BTreeMap<&'a str, &'a str> {
    // 1 巡目: 各 ID の最新の生きた版
    let alive = |id: &str| -> Vec<&'a Candidate> {
        by_id
            .get(id)
            .map(|list| {
                list.iter()
                    .copied()
                    .filter(|c| !dead.contains_key(&(c.id.as_str(), c.version.as_str())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut chosen: BTreeMap<&str, &str> = BTreeMap::new();
    for id in by_id.keys() {
        if let Some(first) = alive(id).first() {
            chosen.insert(*id, first.version.as_str());
        }
    }
    // 依存する側の範囲で絞り込む（数巡で安定する）
    for _ in 0..8 {
        let mut ranges: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for (id, version) in &chosen {
            let c = by_id[id]
                .iter()
                .find(|c| c.version == *version)
                .expect("候補");
            for (dep, range) in &c.dependencies {
                ranges.entry(dep.as_str()).or_default().push(range.as_str());
            }
        }
        let mut next: BTreeMap<&str, &str> = BTreeMap::new();
        for id in by_id.keys() {
            let versions = alive(id);
            let wanted = ranges.get(id).cloned().unwrap_or_default();
            let pick = versions
                .iter()
                .find(|c| {
                    wanted
                        .iter()
                        .all(|r| version_satisfies(r, &c.version) == Some(true))
                })
                .or_else(|| versions.first());
            if let Some(c) = pick {
                next.insert(*id, c.version.as_str());
            }
        }
        if next == chosen {
            break;
        }
        chosen = next;
    }
    chosen
}

/// 選んだ版どうしの辺で、強連結成分（大きさ 2 以上、または自己ループ）を見つける。
/// 戻り値は（成分の ID、経路）。
fn find_cycles(
    chosen: &BTreeMap<&str, &str>,
    by_id: &BTreeMap<&str, Vec<&Candidate>>,
) -> Vec<(Vec<String>, Vec<String>)> {
    let edges = |id: &str| -> Vec<&str> {
        let version = chosen[id];
        let c = by_id[id]
            .iter()
            .find(|c| c.version == version)
            .expect("候補");
        c.dependencies
            .keys()
            .map(String::as_str)
            .filter(|d| chosen.contains_key(d))
            .collect()
    };

    // Tarjan（再帰。依存の深さは浅い想定。深い入れ子でも、拡張機能の数が上限）
    struct State<'a> {
        index: usize,
        indices: BTreeMap<&'a str, usize>,
        low: BTreeMap<&'a str, usize>,
        stack: Vec<&'a str>,
        on_stack: BTreeSet<&'a str>,
        components: Vec<Vec<&'a str>>,
    }
    fn strong<'a>(node: &'a str, edges: &dyn Fn(&str) -> Vec<&'a str>, s: &mut State<'a>) {
        s.indices.insert(node, s.index);
        s.low.insert(node, s.index);
        s.index += 1;
        s.stack.push(node);
        s.on_stack.insert(node);
        for next in edges(node) {
            if !s.indices.contains_key(next) {
                strong(next, edges, s);
                let low = s.low[node].min(s.low[next]);
                s.low.insert(node, low);
            } else if s.on_stack.contains(next) {
                let low = s.low[node].min(s.indices[next]);
                s.low.insert(node, low);
            }
        }
        if s.low[node] == s.indices[node] {
            let mut component = Vec::new();
            while let Some(top) = s.stack.pop() {
                s.on_stack.remove(top);
                component.push(top);
                if top == node {
                    break;
                }
            }
            s.components.push(component);
        }
    }

    let mut state = State {
        index: 0,
        indices: BTreeMap::new(),
        low: BTreeMap::new(),
        stack: Vec::new(),
        on_stack: BTreeSet::new(),
        components: Vec::new(),
    };
    let keys: Vec<&str> = chosen.keys().copied().collect();
    for node in keys {
        if !state.indices.contains_key(node) {
            strong(node, &edges, &mut state);
        }
    }

    let mut out = Vec::new();
    for component in state.components {
        let self_loop = component.len() == 1 && edges(component[0]).contains(&component[0]);
        if component.len() < 2 && !self_loop {
            continue;
        }
        let members: BTreeSet<&str> = component.iter().copied().collect();
        // 最小の ID から、成分の中だけで辿って、閉じる経路を作る
        let start = *members.iter().next().expect("空でない");
        let mut path = vec![start.to_owned()];
        let mut current = start;
        let mut visited: BTreeSet<&str> = BTreeSet::new();
        loop {
            visited.insert(current);
            let next = edges(current)
                .into_iter()
                .filter(|n| members.contains(n))
                .find(|n| *n == start || !visited.contains(n));
            match next {
                Some(n) if n == start => {
                    path.push(start.to_owned());
                    break;
                }
                Some(n) => {
                    path.push(n.to_owned());
                    current = n;
                }
                None => break,
            }
        }
        out.push((members.iter().map(|s| (*s).to_owned()).collect(), path));
    }
    out
}

/// 依存先が先になる順（Kahn。同じ段は ID の昇順）。
fn activation_order(
    chosen: &BTreeMap<&str, &str>,
    by_id: &BTreeMap<&str, Vec<&Candidate>>,
) -> Vec<(String, String)> {
    let mut waiting: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for (id, version) in chosen {
        let c = by_id[id]
            .iter()
            .find(|c| c.version == *version)
            .expect("候補");
        let deps: BTreeSet<&str> = c
            .dependencies
            .keys()
            .map(String::as_str)
            .filter(|d| chosen.contains_key(d))
            .collect();
        waiting.insert(*id, deps);
    }
    let mut order = Vec::new();
    let mut done: BTreeSet<&str> = BTreeSet::new();
    while let Some(next) = waiting
        .iter()
        .find(|(_, deps)| deps.iter().all(|d| done.contains(d)))
        .map(|(id, _)| *id)
    {
        waiting.remove(next);
        done.insert(next);
        order.push((next.to_owned(), chosen[next].to_owned()));
    }
    order
}
