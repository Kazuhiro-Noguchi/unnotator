# S-02 検証: 拡張機能の動的 import・Shadow DOM・拡張機能間 API・CSP

Beads: `unno-5da`。実施日 2026-11-27。環境: macOS（WKWebView）、開発ビルド（`pnpm tauri dev`）。
**Windows（WebView2）と Linux（WebKitGTK）は未実施**（下の「再実行」を人が実機で行う）。

## 方法

- 拡張機能のフィクスチャ 3 つ（`scripts/spikes/s02/ext-{base,rect,bad}`）を、005 の開発者モードの IPC で登録し、`unno://localhost/ext/<id>/…` から読む。
- 検証コードは `src/shell/dev/spike-s02.ts`。開発ビルドのページは vite が配るため、製品の CSP（`tauri.conf.json` の `csp`）が付かない。そこで、同じ文字列を `<meta http-equiv>` で付けて製品に近づけた（`VITE_S02_PROD_CSP=1`）。`frame-ancestors` は meta では効かないので除いた。
- 結果は vite の WebSocket 経由でファイルに書く（`config/vite.config.ts` の一時のプラグイン）。

## 再実行

```bash
VITE_S02_PROD_CSP=1 VITE_S02_DIR=$PWD/scripts/spikes/s02 pnpm tauri dev
# パレット（Cmd/Ctrl+Shift+P）で「S-02」を実行。結果は画面の重ね表示（ダブルクリックで閉じる）。
# 自動実行・ファイル出力: VITE_S02_AUTORUN=1 S02_OUT=/path/result.txt を足す
```

## 結果

| # | 確かめたこと | 結果 |
| --- | --- | --- |
| 1 | `import("unno://localhost/ext/<id>/dist/index.js")`（製品の CSP のまま） | **成功**。相対 import（`./util.js`）も解決する。初回 5 ms、2 回目 0 ms。CSP の緩和は不要（`script-src` に `unno:` が既にある） |
| 2 | 拡張機能間 API（`activate()` の戻り値を、依存する側へ渡す） | **成功**。モジュールは拡張機能ごとに別インスタンス。受け渡しはホストが仲介する |
| 3a | Shadow DOM 内の `<style>` 本文 | **製品の CSP では不可**（`style-src-elem` 違反）。開発の CSP（`'unsafe-inline'`）では通るので、開発だけで確かめると見逃す |
| 3b | `adoptedStyleSheets`（`replaceSync`） | **成功**（CSP 違反なし） |
| 3c | Shadow DOM 内の `<link rel=stylesheet href=unno://…>` | **製品の CSP では不可**（`style-src` に `unno:` が無い） |
| 3d | `fetch` で CSS を取り、`adoptedStyleSheets` に入れる | **成功**。CSP を緩めずに拡張機能の CSS を使える経路 |
| 3e | Shadow DOM の内側の CSS が外へ漏れるか | 漏れない |
| 4 | iframe `sandbox="allow-scripts"`（`unno://…/view.html`） | **動かない**。`sandbox` だけだと origin が opaque になり、HTML の CSP `script-src 'self'` が自分の JS を拒む |
| 4' | iframe `sandbox="allow-scripts allow-same-origin"` | **動く**。postMessage の往復 OK。origin は `unno://localhost`。親の DOM へは `SecurityError`。`__TAURI_INTERNALS__` は iframe に無い。HTML のインライン script は CSP で止まる |
| 5a/b | import 時の例外・構文エラー | `import()` の拒否として捕捉できる（メッセージも取れる） |
| 5c | 非同期の例外の帰属 | Promise の拒否は `reason.stack` に `unno://localhost/ext/<id>/…` が出るので**帰属できる**。`setTimeout` の中の例外は `window.onerror` に `Script error.`（出所なし）で来て、**帰属できない** |
| 6a | 拡張機能の JS が `window.__TAURI_INTERNALS__.invoke(...)` で Rust のコマンドを直接呼べるか | **呼べる**（`withGlobalTauri: false` でも `__TAURI_INTERNALS__` は見える）。`devmode_get` が通った |
| 6b | 外部への `fetch` | 製品の CSP で**ブロック**された（`connect-src`） |

## plan への入力（009）

1. **読み込み**: `import(url)` でよい。CSP の変更は要らない。URL は `unno://localhost/ext/<id>/…`（Windows は `http://unno.localhost/ext/<id>/…`。`src/preview/url.ts` と同じ規則）。更新（開発者モードの再読込）では、URL に版やカウンターのクエリを付けてキャッシュを避ける必要がある（要確認）。
2. **CSS**: `<style>`・`<link>` は使えない。ホストが `fetch` → `adoptedStyleSheets` で Shadow DOM に入れる。拡張機能が自分で `<style>` を作る実装は、製品では動かない。この制約は拡張機能の作者向けの文書に書く。
3. **iframe ビュー**: `sandbox="allow-scripts allow-same-origin"` が要る。`unno://localhost` が全拡張機能で同じ origin になるため、iframe の中の JS 同士は互いのファイルや `unno://asset/` を読める。親や Tauri の IPC には届かない。拡張機能ごとに origin を分けるには、`unno://<ext-id>/…` の形（ホスト名で分ける）への変更が要る。**これは契約（`protocol.md`）の変更になる。plan で提案して止まる。**
4. **権限の強制の限界（重要）**: 拡張機能の JS は、ホストを通さずに `__TAURI_INTERNALS__.invoke` で Rust のコマンドを呼べる。Rust 側は、その呼び出しがどの拡張機能からかを知らない。したがって「権限はシェル（TS）と Rust の両方で確認する」（憲章 V）を成り立たせるには、拡張機能に代わってホストが送る呼び出しに拡張機能 ID を載せる設計が要るが、悪意ある拡張機能が ID を偽って直接呼ぶ経路は塞げない。設計書 5.1 の「同じ WebView の JS は完全には封じられない。権限は宣言と同意」と一致する。plan では、(a) 拡張機能のためのコマンド（`apply_command` など）に、`source`（拡張機能 ID）を必ず載せて journal に残す、(b) 直接呼びを検知・制限する案（拡張機能の読み込み前に `__TAURI_INTERNALS__` を隠す・差し替える。ただし、シェル自身の呼び出しと区別できるかを別に検証）を検討する。
5. **例外の隔離**: ホストが拡張機能へ渡すコールバックと、拡張機能の登録したハンドラーはすべて `try/catch`（と `await` の拒否）で包む。`unhandledrejection` は `stack` の URL から拡張機能 ID を割り出して数える。`window.onerror` の `Script error.` は帰属できないので、アプリ全体の「不明」として記録するだけにする（拡張機能の自動無効の判定には使わない）。
6. **外部通信**: 製品の CSP の `connect-src` が拡張機能の外部通信を止める。`network` 権限を許す設計にするなら、CSP を緩めずに済む方法（ホスト経由の `fetch`）が要る。憲章 V は外部通信を禁じているので、当面は `network` を実装しない。
7. **未確認**: Windows・Linux、動作中の再読込（更新時のキャッシュ）、拡張機能のコードのスタックオーバーフロー・無限ループによる UI 停止（Worker に出さない限り防げない。仕様では「保証しない」と明記）。

## 後始末

検証コード（`src/shell/dev/spike-s02.ts`、`src/App.tsx` と `demo-commands.ts` の差し込み、`config/vite.config.ts` のプラグイン）は、Windows・Linux の再実行が済んだら消してよい。フィクスチャ（`scripts/spikes/s02/`）は 009 のテスト用フィクスチャの元になる。
