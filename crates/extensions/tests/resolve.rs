//! 依存の解決: 順番・欠落・版・循環・API の版・連鎖・固定・無効化（spec.md US3、research.md R4）。
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use support::manifest;
use unnotator_extensions::manifest::Manifest;
use unnotator_extensions::registry::{
    DisabledReason, ExtensionStatus, Origin, ProblemKind, RawExtension, Registry, RegistryInput,
};
use unnotator_extensions::state::ExtensionsState;

fn raw(id: &str, version: &str, deps: &[(&str, &str)]) -> RawExtension {
    let mut b = manifest(id, version);
    for (dep, range) in deps {
        b = b.dep(dep, range);
    }
    from(b.build())
}

fn from(value: serde_json::Value) -> RawExtension {
    RawExtension::new(
        PathBuf::from("/ext"),
        Origin::Installed,
        Manifest::from_value(value).unwrap(),
    )
}

fn build_with(extensions: &[RawExtension], state: &ExtensionsState) -> Registry {
    Registry::build(RegistryInput {
        installed: extensions,
        state,
        app_api_version: "0.0.1",
    })
}

fn build(extensions: &[RawExtension]) -> Registry {
    build_with(extensions, &ExtensionsState::default())
}

fn status(registry: &Registry, id: &str) -> ExtensionStatus {
    registry.entry(id).unwrap().status
}

fn problem_kinds(registry: &Registry, id: &str) -> Vec<ProblemKind> {
    registry
        .problems()
        .iter()
        .filter(|p| p.extension_id == id)
        .map(|p| p.kind)
        .collect()
}

fn enabled(registry: &Registry, id: &str) -> bool {
    matches!(status(registry, id), ExtensionStatus::Enabled { .. })
}

#[test]
fn dependencies_come_first_and_the_order_is_deterministic() {
    let a = raw("com.example.a", "1.0.0", &[("com.example.b", "^1.0.0")]);
    let b = raw("com.example.b", "1.2.0", &[]);
    let c = raw("com.example.c", "1.0.0", &[]);
    let expected = ["com.example.b", "com.example.a", "com.example.c"];
    // 入力の順をすべて入れ替えても同じ
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        let all = [a.clone(), b.clone(), c.clone()];
        let shuffled: Vec<_> = order.iter().map(|&i| all[i].clone()).collect();
        let registry = build(&shuffled);
        assert_eq!(registry.order(), expected, "入力順 {order:?}");
        assert_eq!(
            status(&registry, "com.example.a"),
            ExtensionStatus::Enabled { order: 1 }
        );
    }
}

#[test]
fn a_missing_dependency_disables_it_and_everything_that_needs_it() {
    let a = raw("com.example.a", "1.0.0", &[("com.example.ghost", "^1.0.0")]);
    let c = raw("com.example.c", "1.0.0", &[("com.example.a", "^1.0.0")]);
    let d = raw("com.example.d", "1.0.0", &[]);
    let registry = build(&[a, c, d]);
    assert!(matches!(
        status(&registry, "com.example.a"),
        ExtensionStatus::Invalid
    ));
    assert_eq!(
        problem_kinds(&registry, "com.example.a"),
        [ProblemKind::MissingDependency]
    );
    let p = registry
        .problems()
        .iter()
        .find(|p| p.extension_id == "com.example.a")
        .unwrap();
    assert_eq!(
        p.detail.as_ref().unwrap()["dependency"],
        "com.example.ghost"
    );
    assert_eq!(p.detail.as_ref().unwrap()["required"], "^1.0.0");
    // 連鎖
    assert!(matches!(
        status(&registry, "com.example.c"),
        ExtensionStatus::Invalid
    ));
    assert_eq!(
        problem_kinds(&registry, "com.example.c"),
        [ProblemKind::DependencyInvalid]
    );
    // 無関係なものは妨げられない
    assert!(enabled(&registry, "com.example.d"));
}

#[test]
fn a_dependency_version_outside_the_range_is_reported_with_both_sides() {
    let a = raw("com.example.a", "1.0.0", &[("com.example.b", "^2.0.0")]);
    let b = raw("com.example.b", "1.5.0", &[]);
    let registry = build(&[a, b]);
    assert_eq!(
        problem_kinds(&registry, "com.example.a"),
        [ProblemKind::DependencyVersion]
    );
    let p = &registry.problems()[0];
    let detail = p.detail.as_ref().unwrap();
    assert_eq!(detail["required"], "^2.0.0");
    assert_eq!(detail["installed"][0], "1.5.0");
    assert!(enabled(&registry, "com.example.b"));
}

#[test]
fn a_cycle_disables_every_member_and_names_the_path() {
    let a = raw("com.example.a", "1.0.0", &[("com.example.b", "*")]);
    let b = raw("com.example.b", "1.0.0", &[("com.example.a", "*")]);
    let d = raw("com.example.d", "1.0.0", &[("com.example.d", "*")]); // 自分自身
    let e = raw("com.example.e", "1.0.0", &[]);
    let registry = build(&[a, b, d, e]);
    for id in ["com.example.a", "com.example.b", "com.example.d"] {
        assert!(
            matches!(status(&registry, id), ExtensionStatus::Invalid),
            "{id}"
        );
        assert_eq!(problem_kinds(&registry, id), [ProblemKind::Cycle], "{id}");
    }
    let p = registry
        .problems()
        .iter()
        .find(|p| p.extension_id == "com.example.a")
        .unwrap();
    let path: Vec<&str> = p.detail.as_ref().unwrap()["path"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(path, ["com.example.a", "com.example.b", "com.example.a"]);
    assert!(enabled(&registry, "com.example.e"));
}

#[test]
fn something_that_depends_on_a_cycle_is_disabled_too() {
    let a = raw("com.example.a", "1.0.0", &[("com.example.b", "*")]);
    let b = raw("com.example.b", "1.0.0", &[("com.example.a", "*")]);
    let c = raw("com.example.c", "1.0.0", &[("com.example.a", "*")]);
    let registry = build(&[a, b, c]);
    assert_eq!(
        problem_kinds(&registry, "com.example.c"),
        [ProblemKind::DependencyInvalid]
    );
}

#[test]
fn an_engine_range_the_app_does_not_satisfy_disables_it() {
    let future = from(
        manifest("com.example.future", "1.0.0")
            .engine("^2.0.0")
            .build(),
    );
    let user = raw("com.example.user", "1.0.0", &[("com.example.future", "*")]);
    let registry = build(&[future, user]);
    assert_eq!(
        problem_kinds(&registry, "com.example.future"),
        [ProblemKind::Engine]
    );
    let p = registry
        .problems()
        .iter()
        .find(|p| p.extension_id == "com.example.future")
        .unwrap();
    assert_eq!(p.detail.as_ref().unwrap()["required"], "^2.0.0");
    assert_eq!(p.detail.as_ref().unwrap()["app"], "0.0.1");
    assert!(matches!(
        status(&registry, "com.example.user"),
        ExtensionStatus::Invalid
    ));
}

#[test]
fn the_newest_version_that_fits_every_dependent_is_chosen() {
    let b1 = raw("com.example.b", "1.0.0", &[]);
    let b12 = raw("com.example.b", "1.2.0", &[]);
    let b2 = raw("com.example.b", "2.0.0", &[]);
    let a = raw("com.example.a", "1.0.0", &[("com.example.b", "^1.0.0")]);
    let registry = build(&[b1, b12, b2, a]);
    assert!(enabled(&registry, "com.example.a"));
    assert_eq!(registry.entry("com.example.b").unwrap().version, "1.2.0");
    assert_eq!(
        registry.entry("com.example.b").unwrap().installed_versions,
        ["2.0.0", "1.2.0", "1.0.0"]
    );
    // 依存する側がなければ、最新が選ばれる
    let alone = build(&[
        raw("com.example.b", "1.0.0", &[]),
        raw("com.example.b", "2.0.0", &[]),
    ]);
    assert_eq!(alone.entry("com.example.b").unwrap().version, "2.0.0");
}

#[test]
fn a_pinned_version_is_used_and_a_missing_pin_is_a_problem() {
    let mut state = ExtensionsState::default();
    state.pin("com.example.b", Some("1.0.0")).unwrap();
    let registry = build_with(
        &[
            raw("com.example.b", "1.0.0", &[]),
            raw("com.example.b", "2.0.0", &[]),
        ],
        &state,
    );
    assert_eq!(registry.entry("com.example.b").unwrap().version, "1.0.0");

    state.pin("com.example.b", Some("3.0.0")).unwrap();
    let registry = build_with(&[raw("com.example.b", "1.0.0", &[])], &state);
    assert!(matches!(
        status(&registry, "com.example.b"),
        ExtensionStatus::Invalid
    ));
    assert_eq!(
        problem_kinds(&registry, "com.example.b"),
        [ProblemKind::PinnedVersionMissing]
    );
}

#[test]
fn a_user_disabled_extension_disables_its_dependents() {
    let mut state = ExtensionsState::default();
    state.set_disabled("com.example.b", true);
    let b = raw("com.example.b", "1.0.0", &[]);
    let a = raw("com.example.a", "1.0.0", &[("com.example.b", "*")]);
    let c = raw("com.example.c", "1.0.0", &[("com.example.a", "*")]);
    let d = raw("com.example.d", "1.0.0", &[]);
    let registry = build_with(&[a, b, c, d], &state);
    assert_eq!(
        status(&registry, "com.example.b"),
        ExtensionStatus::Disabled(DisabledReason::UserDisabled)
    );
    assert_eq!(
        status(&registry, "com.example.a"),
        ExtensionStatus::Disabled(DisabledReason::DependencyDisabled)
    );
    assert_eq!(
        status(&registry, "com.example.c"),
        ExtensionStatus::Disabled(DisabledReason::DependencyDisabled)
    );
    assert!(enabled(&registry, "com.example.d"));
    assert!(registry.problems().is_empty(), "利用者の選択は問題ではない");
    assert_eq!(registry.order(), ["com.example.d"]);
}

#[test]
fn a_broken_newer_version_falls_back_to_an_older_good_one() {
    let good = raw("com.example.a", "1.0.0", &[]);
    // 他に依らない確認（宣言の重複）で外れる版は、解決の対象から外れ、古い版が使われる
    let broken = from(
        manifest("com.example.a", "2.0.0")
            .media_type("text", &[".txt"], &[])
            .media_type("text", &[".md"], &[])
            .build(),
    );
    let registry = build(&[good, broken]);
    assert!(enabled(&registry, "com.example.a"));
    assert_eq!(registry.entry("com.example.a").unwrap().version, "1.0.0");
    // 新しい版の問題は、残る
    let p = registry
        .problems()
        .iter()
        .find(|p| p.version.as_deref() == Some("2.0.0"))
        .unwrap();
    assert_eq!(p.kind, ProblemKind::ManifestSemantic);
}

#[test]
fn a_dependency_chain_keeps_unrelated_extensions_untouched() {
    let mut all = vec![raw("com.example.root", "1.0.0", &[])];
    for i in 1..=5 {
        let prev = if i == 1 {
            "com.example.root".to_owned()
        } else {
            format!("com.example.n{}", i - 1)
        };
        all.push(raw(
            &format!("com.example.n{i}"),
            "1.0.0",
            &[(prev.as_str(), "*")],
        ));
    }
    let registry = build(&all);
    let order: Vec<&str> = registry.order().iter().map(String::as_str).collect();
    assert_eq!(
        order,
        [
            "com.example.root",
            "com.example.n1",
            "com.example.n2",
            "com.example.n3",
            "com.example.n4",
            "com.example.n5"
        ]
    );
}
