# S-02 検証: 拡張機能の動的 import・Shadow DOM・拡張機能間 API・CSP

Beads: `unno-5da`。実施日 2026-11-27。環境: macOS（WKWebView）、開発ビルド（`pnpm tauri dev`）。
Windows（WebView2）と Linux（WebKitGTK）は 2026-11-28 に実施済み（下の「Windows の結果」「Linux の結果」）。

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
| 4b' | iframe `sandbox="allow-scripts"` で、HTML の CSP を `script-src unno: http://unno.localhost` に変えた場合（`EXT_HTML_CSP` を一時的に変えて確認。変更は戻した） | **動く**。外部 JS・ES Module（相対 import・トップレベル `await` つき）とも postMessage の往復 OK。`localStorage` は `SecurityError`（opaque origin なので保存データが拡張機能間で共有されない）。`unno://` への `fetch` は `connect-src 'none'` で拒否。`__TAURI_INTERNALS__` は無い。**契約の変更なしで、拡張機能ごとの隔離ができる** |
| 4' | iframe `sandbox="allow-scripts allow-same-origin"` | **動く**。postMessage の往復 OK。origin は `unno://localhost`。親の DOM へは `SecurityError`。`__TAURI_INTERNALS__` は iframe に無い。HTML のインライン script は CSP で止まる |
| 5a/b | import 時の例外・構文エラー | `import()` の拒否として捕捉できる（メッセージも取れる） |
| 5c | 非同期の例外の帰属 | Promise の拒否は `reason.stack` に `unno://localhost/ext/<id>/…` が出るので**帰属できる**。`setTimeout` の中の例外は `window.onerror` に `Script error.`（出所なし）で来て、**帰属できない** |
| 6a | 拡張機能の JS が `window.__TAURI_INTERNALS__.invoke(...)` で Rust のコマンドを直接呼べるか | **呼べる**（`withGlobalTauri: false` でも `__TAURI_INTERNALS__` は見える）。`devmode_get` が通った |
| 6b | 外部への `fetch` | 製品の CSP で**ブロック**された（`connect-src`） |

## Windows の結果（WebView2、2026-11-28）

環境: Windows 11、開発ビルド（`pnpm tauri dev`）、URL は `http://unno.localhost/ext/<id>/…`。ブランチ `spike/s02-windows-iframe`（`view-module.*` のフィクスチャを足し、枠の中から Rust の IPC が届くかの検査 4i を足した）。

| # | Windows の結果 | macOS との違い |
| --- | --- | --- |
| 1・1b | `import()` 成功（初回 5 ms、2 回目 0 ms）。相対 import も可 | 同じ |
| 2 | 拡張機能間 API 成功 | 同じ |
| 3a〜3e | `<style>` 本文 不可、`adoptedStyleSheets` 可、`<link>` 不可、`fetch` → `adoptedStyleSheets` 可、外へ漏れない | 同じ |
| 4m `view.html`（`sandbox="allow-scripts"`、CSP は `script-src 'self'` のまま） | 往復 OK。origin は `http://unno.localhost`、親の DOM は `SecurityError` | **違う**: macOS では `'self'` だと動かず、CSP の変更が要った。Windows では `http://unno.localhost` の `'self'` が一致して動く |
| 4m `view-module.html`（ES Module） | OK。`module: true`、`localStorage` は `SecurityError`、`fetch` は blocked | 同じ（CSP を変えた macOS の結果と） |
| 4a・4b（`allow-same-origin` の有無） | 往復 OK、インライン script は止まる | 同じ |
| **4i** 枠の中から `__TAURI_INTERNALS__.invoke`（`plugin:event|emit`）が Rust に届くか | **届かなかった**。ただし、枠の中に `__TAURI_INTERNALS__` の**オブジェクトは存在する**（`hasTauriInternals: true`）。`invoke` は応答が戻らず、タイムアウトする。本体が `listen` している副作用のイベントは、受信されなかった | **違う**: macOS では、オブジェクト自体が枠に無い。Windows では、あるが、Rust に届かない |
| 5a・5b | `import` 時の例外・構文エラーを捕捉 | 同じ |
| 5c | `setTimeout` 内の例外が `Uncaught Error: … @ http://unno.localhost/ext/dev.spike.bad/dist/index.js:2` と、**出所の URL つきで来る**（帰属できる） | **違う（良い差）**: macOS では出所なし |
| 6 | 本体の JS からの `invoke` は通る（`enabled: true`）。外部通信は blocked | 同じ |

**009 への入力**:
- 枠の中に `__TAURI_INTERNALS__` が見える OS がある。Rust に届かないことは確認できたが、**この挙動を前提にしない**。枠の起動用コード（`packages/frame-runtime`）が、拡張機能のコードを読み込む前に `__TAURI_INTERNALS__` を消す（または触れなくする）対策を、念のため入れる。また、009 の敵対的なテストに、「枠の中から副作用のある IPC を呼んでも届かない」検査（本体の `listen` で受信を数える方式）を含める。
- `view.html` の CSP は、`script-src unno: http://unno.localhost`（plan どおり）で、macOS・Windows の両方で動く。
- 非同期の例外の帰属は、macOS では難しいが Windows では可能。仕様は「枠ごとに帰属する」ので、どちらでも成り立つ。

## Linux の結果（WebKitGTK、2026-11-28）

環境: Ubuntu（GNOME）、開発ビルド（`pnpm tauri dev`）、URL は `unno://localhost/ext/<id>/…`。Windows と同じブランチ（`spike/s02-windows-iframe`）。EXT_HTML_CSP は変えていない（`script-src 'self'`）。

**macOS（WebKit）とほぼ同じ**。違いは、下の 1 点だけ。

| # | Linux の結果 | macOS との違い |
| --- | --- | --- |
| 1・1b・2 | `import()` 成功（初回 1 ms、2 回目 0 ms）、拡張機能間 API 成功 | 同じ |
| 3a〜3e | `<style>` 本文 不可、`adoptedStyleSheets` 可、`<link>` 不可、`fetch` → `adoptedStyleSheets` 可、外へ漏れない | 同じ |
| 4m・4a（`sandbox="allow-scripts"`、`script-src 'self'` のまま） | **NG**（メッセージなし）。opaque origin では `'self'` が一致せず、枠の中のスクリプトが読めない | 同じ（macOS の 4 と同じ。CSP を `script-src unno: http://unno.localhost` に変える必要がある） |
| 4a・4b（`allow-same-origin`） | 往復 OK、origin は `unno://localhost`、親の DOM は `SecurityError`、`hasTauriInternals: false`、インライン script は止まる | 同じ |
| 4b（`allow-scripts`） | インライン script は止まる | 同じ |
| **4i** | 届かなかった（安全）。枠の中に `__TAURI_INTERNALS__` が**無い**（`invoke: no-internals`） | 同じ（Windows とは違う） |
| 5a・5b | 例外・構文エラーを捕捉 | 同じ |
| 5c | Promise の拒否は `stack=activate@unno://localhost/ext/dev.spike.bad/dist/index.js:3:27` で**帰属できる**。`setTimeout` 内の例外は `Script error. @ :0 stack=none` で**帰属できない** | 同じ |
| 6 | 本体の JS からの `invoke` は通る（`enabled: true`）。外部通信は blocked | 同じ |

**未確認（Linux・Windows とも）**: CSP を `script-src unno: http://unno.localhost` に変えたときの `sandbox="allow-scripts"` の動作（macOS では確認済み）。009 の T009 と T052 で、実機で確かめる。

## plan への入力（009）

1. **読み込み**: `import(url)` でよい。CSP の変更は要らない。URL は `unno://localhost/ext/<id>/…`（Windows は `http://unno.localhost/ext/<id>/…`。`src/preview/url.ts` と同じ規則）。更新（開発者モードの再読込）では、URL に版やカウンターのクエリを付けてキャッシュを避ける必要がある（要確認）。
2. **CSS**: `<style>`・`<link>` は使えない。ホストが `fetch` → `adoptedStyleSheets` で Shadow DOM に入れる。拡張機能が自分で `<style>` を作る実装は、製品では動かない。この制約は拡張機能の作者向けの文書に書く。
3. **iframe の origin**: `allow-same-origin` を付けると origin が全拡張機能で `unno://localhost` になり、保存データが共有される。付けずに、`unno://…/ext/` の HTML の CSP を `script-src 'self'` から `script-src unno: http://unno.localhost` に変えれば、`sandbox="allow-scripts"`（opaque origin）のまま動く（4b'）。URL の形は変えないので契約の変更は要らない。変えるのは `crates/core/src/serve/mime.rs` の `EXT_HTML_CSP`（と 005 の `research.md` R9 の記述・関連テスト）。
4. **方針（2026-11-27、人が決定）: 拡張機能のコードは拡張機能ごとの iframe の中で動かす**（`sandbox="allow-scripts"`、postMessage の RPC。ホストが送り主を特定できる）。下の限界は「同じ WebView の JS 空間で動かす」場合の話で、この方針で解消する。plan で、Host API のうち iframe の境界を越えにくいもの（同期の戻り値: `assets.url`・`selection.get`・`labels.active`、ホストが拡張機能を同期で呼ぶ `AnnotationTypeImpl.summarize`、`getApi` が返す関数、`ctx.container` の DOM）の扱いを決める。**`packages/plugin-api/index.d.ts` を変える場合は、変えずに済ませる案とあわせて提案して止まる。**
4'. **権限の強制の限界（同じ JS 空間の場合）**: 拡張機能の JS は、ホストを通さずに `__TAURI_INTERNALS__.invoke` で Rust のコマンドを呼べる。Rust 側は、その呼び出しがどの拡張機能からかを知らない。したがって「権限はシェル（TS）と Rust の両方で確認する」（憲章 V）を成り立たせるには、拡張機能に代わってホストが送る呼び出しに拡張機能 ID を載せる設計が要るが、悪意ある拡張機能が ID を偽って直接呼ぶ経路は塞げない。設計書 5.1 の「同じ WebView の JS は完全には封じられない。権限は宣言と同意」と一致する。plan では、(a) 拡張機能のためのコマンド（`apply_command` など）に、`source`（拡張機能 ID）を必ず載せて journal に残す、(b) 直接呼びを検知・制限する案（拡張機能の読み込み前に `__TAURI_INTERNALS__` を隠す・差し替える。ただし、シェル自身の呼び出しと区別できるかを別に検証）を検討する。
5. **例外の隔離**: ホストが拡張機能へ渡すコールバックと、拡張機能の登録したハンドラーはすべて `try/catch`（と `await` の拒否）で包む。`unhandledrejection` は `stack` の URL から拡張機能 ID を割り出して数える。`window.onerror` の `Script error.` は帰属できないので、アプリ全体の「不明」として記録するだけにする（拡張機能の自動無効の判定には使わない）。
6. **外部通信**: 製品の CSP の `connect-src` が拡張機能の外部通信を止める。`network` 権限を許す設計にするなら、CSP を緩めずに済む方法（ホスト経由の `fetch`）が要る。憲章 V は外部通信を禁じているので、当面は `network` を実装しない。
7. **未確認**: 動作中の再読込（更新時のキャッシュ）、拡張機能のコードのスタックオーバーフロー・無限ループによる UI 停止（Worker に出さない限り防げない。仕様では「保証しない」と明記）。

## 後始末

検証コード（`src/shell/dev/spike-s02.ts`、`src/App.tsx` と `demo-commands.ts` の差し込み、`config/vite.config.ts` のプラグイン）は、Windows・Linux の再実行が済んだら消してよい。フィクスチャ（`scripts/spikes/s02/`）は 009 のテスト用フィクスチャの元になる。
