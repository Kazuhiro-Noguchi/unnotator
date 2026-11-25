# unnotator

様々な形式に拡張機能で対応できる汎用アノテーションツール。Tauri v2（Rust）+ SolidJS/TypeScript で、完全ローカルで動く。
媒体（画像・テキスト・音声…）の扱いはすべて別リポジトリの拡張機能が担う。開発の規則は [CLAUDE.md](CLAUDE.md)。

## 必要な道具

| 道具 | 版 | 備考 |
| --- | --- | --- |
| Rust | `rust-toolchain.toml` の版（1.99.1） | rustup があれば自動で入る（clippy・rustfmt を含む） |
| Node.js | 24 以上 | `engines` と `.npmrc` の `engine-strict` で版を強制する |
| pnpm | 10 系（`packageManager` で固定） | Node 同梱の corepack で有効にする |
| Python | 3.10 以上 | Beads と Spec Kit の補助スクリプト用（アプリのビルドには不要） |

### OS ごとの前提（Tauri）

- **macOS**: Xcode の Command Line Tools（`xcode-select --install`）。
- **Linux**: WebKitGTK などの開発用パッケージ（例: Debian/Ubuntu では
  `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`）。
- **Windows**: Microsoft C++ Build Tools（MSVC）と WebView2。

## 取得してから

```bash
corepack enable
pnpm install --frozen-lockfile
```

`corepack enable` が権限で失敗するときは、`corepack enable --install-directory <PATH 上の書き込める場所> pnpm` を使う。

## 確認コマンド（各機能の完了条件）

6 つがすべて成功するまで、作業は完了にしない。

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm schema:check
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

| コマンド | 検査する内容 |
| --- | --- |
| `pnpm lint` | Biome と、依存の向き・版の書き方（`scripts/check-deps.mjs`） |
| `pnpm typecheck` | シェルと契約の TS ファイルの型検査 |
| `pnpm test` | Vitest |
| `pnpm schema:check` | 契約の検査（DB スキーマ・マニフェストの見本・契約の型・plugin-api のパッケージ） |
| `cargo clippy ...` | Rust の静的解析（警告はすべてエラー） |
| `cargo test --workspace` | Rust のテスト（IPC の型の差分検出を含む） |

## 起動と計測

| コマンド | 内容 |
| --- | --- |
| `pnpm tauri dev` | 開発用に起動し、空のウィンドウを開く |
| `pnpm tauri build --no-bundle` | アプリのバイナリをビルドする |
| `pnpm measure:startup` | ビルド済みのアプリを 5 回起動し、起動時間の中央値と最大値を出す |
| `pnpm ipc:gen` | `src/ipc/bindings.ts` を生成し直す（Rust のコマンドを変えたあと） |

## 構成

- `crates/core`・`crates/extensions`・`crates/worker`: Rust のライブラリ（Tauri に依存しない）。依存の向きは `worker → extensions → core`。
- `src-tauri`: Tauri アプリ。`crates/*` に依存する。
- `src/`: SolidJS のシェル。Rust との通信は `src/ipc/`、拡張機能の呼び出しは `src/host/` を経由する。
- `packages/plugin-api`: 拡張機能の作者向けの型定義 `@unnotator/plugin-api`。
- 契約の正本（変えずに済まないときは止まって提案する）: `crates/core/migrations/{project,recovery}/*.sql`・
  `crates/extensions/schema/unnotator-plugin.schema.json`・`crates/worker/protocol/protocol.ts`・`packages/plugin-api/index.d.ts`。

## ライセンス

[MIT](LICENSE)
