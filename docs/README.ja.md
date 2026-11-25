# unnotator

**拡張機能であらゆる形式に対応できる、汎用のアノテーションツール。**

[English](../README.md) · [ライセンス: MIT](../LICENSE)

unnotator は Tauri v2（Rust）と SolidJS/TypeScript で作るデスクトップアプリです。アカウントもサーバーも要らず、すべて手元のマシンだけで動きます。

コアは媒体を知りません。画像・テキスト・音声などの扱いは、別リポジトリの拡張機能が担います。コアが管理するのは、プロジェクト、アノテーション、関係、ラベル、Undo/Redo だけです。

> **状況: 開発の初期段階です。** 今あるのはリポジトリの土台（ワークスペース、ビルド、型付き IPC、契約の検査）だけで、アプリは空のウィンドウを開きます。注釈を付けられる機能はまだ無く、リリースもありません。

## 設計の方針

- **媒体を知らないコア。** 座標・ピクセル・時刻・文字位置はコアに入れません。基準は「音声ファイルでも意味があるか」です。
- **媒体の処理は拡張機能。** 拡張機能はマニフェスト（`unnotator-plugin.json`、JSON Schema で検証）で記述し、型付きの `@unnotator/plugin-api` に沿って書きます。
- **書き込みの入口は 1 つ。** プロジェクトのデータは Rust のコマンド層だけが変更します。JavaScript でも Python でも、拡張機能がデータベースを直接触ることはありません。
- **完全ローカル。** 外部への通信はしません。CSP は厳しく設定し、`withGlobalTauri` は無効です。

## リポジトリの構成

| パス | 役割 |
| --- | --- |
| `crates/core` | プロジェクトのデータと DB スキーマ（Rust ライブラリ。Tauri に依存しない） |
| `crates/extensions` | 拡張機能のマニフェストのスキーマ（Rust ライブラリ） |
| `crates/worker` | 拡張機能のプロセスとのプロトコル（Rust ライブラリ） |
| `src-tauri` | Tauri アプリ本体 |
| `src/` | SolidJS のシェル。Rust との通信は `src/ipc/` を経由する |
| `packages/plugin-api` | `@unnotator/plugin-api`: 拡張機能の作者向けの TypeScript の型定義 |
| `config/` | ツールの設定（Vite・Vitest・Biome・Clippy） |
| `scripts/` | リポジトリ用のスクリプト（検査・計測） |
| `docs/` | 文書（日本語の README を含む） |

依存の向きは一方向です。`src-tauri → crates/*`、`worker → extensions → core`。

## はじめかた

### 必要な道具

| 道具 | 版 |
| --- | --- |
| Rust | `rust-toolchain.toml` で固定（rustup が自動で入れる） |
| Node.js | 24 以上 |
| pnpm | 10 系（`corepack` で有効にする） |

Tauri のために、OS ごとの前提もあります。

- **macOS:** Xcode Command Line Tools（`xcode-select --install`）
- **Linux:** WebKitGTK など。Debian/Ubuntu なら `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`
- **Windows:** Microsoft C++ Build Tools（MSVC）と WebView2

### 入れて動かす

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

`corepack enable` が権限で失敗するときは、`corepack enable --install-directory <PATH 上の書き込める場所> pnpm` を使ってください。

## 開発

変更を終えたとみなす前に、6 つの確認コマンドをすべて通します。

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm schema:check
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

| コマンド | 検査する内容 |
| --- | --- |
| `pnpm lint` | Biome と、依存の向き・依存の版の書き方 |
| `pnpm typecheck` | シェルと契約の TypeScript ファイルの型検査（厳しい設定） |
| `pnpm test` | Vitest |
| `pnpm schema:check` | 契約の検査。DB スキーマが空の DB に適用できること、マニフェストの見本の検証、契約の型の検査、`@unnotator/plugin-api` を固めて利用側から使えること |
| `cargo clippy ...` | Rust の静的解析（警告はエラー） |
| `cargo test --workspace` | Rust のテスト。`src/ipc/bindings.ts` が最新であることの検査を含む |

そのほかのコマンド:

| コマンド | 内容 |
| --- | --- |
| `pnpm tauri build --no-bundle` | アプリのバイナリをビルドする |
| `pnpm measure:startup` | ビルド済みのアプリを 5 回起動し、起動時間の中央値と最大値を出す |
| `pnpm ipc:gen` | Rust のコマンドを変えたあと、`src/ipc/bindings.ts` を生成し直す |

### 契約ファイル

システムの各部分の間の取り決めの正本は、次の 5 つのファイルです。直す必要があるときは、ついでに変えず、提案して決めます。

- `crates/core/migrations/{project,recovery}/*.sql`
- `crates/extensions/schema/unnotator-plugin.schema.json`
- `crates/worker/protocol/protocol.ts`
- `packages/plugin-api/index.d.ts`

### 規約

- Rust: テスト以外で `unwrap()` を使わない。エラーは `thiserror`、ログは `tracing`。
- TypeScript: `any` を使わない。画面の文字列は i18n（日英）を通し、色はテーマの CSS 変数で指定する。
- コミットは [Conventional Commits](https://www.conventionalcommits.org/ja/) に従う。

貢献者・エージェント向けの作業手順は [CLAUDE.md](../CLAUDE.md) にあります。

## ライセンス

[MIT](../LICENSE)
