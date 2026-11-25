# unnotator

**A general-purpose annotation tool that supports any media type through extensions.**

[日本語](docs/README.ja.md) · [License: MIT](LICENSE)

unnotator is a desktop app built with Tauri v2 (Rust) and SolidJS/TypeScript. It runs entirely on your machine: no accounts, no servers.

The core knows nothing about media. Images, text, audio and anything else are handled by extensions that live in their own repositories. The core only manages projects, annotations, relations, labels and undo/redo.

> **Status: early development.** Only the repository foundation exists today (workspace, build, typed IPC, contract checks). The app opens an empty window. There is nothing to annotate with yet, and no releases.

## Design principles

- **Media-agnostic core.** Coordinates, pixels, timestamps and character offsets never appear in the core. The test is: "would this still make sense for an audio file?"
- **Extensions do the media work.** An extension is described by a manifest (`unnotator-plugin.json`, validated by a JSON Schema) and written against the typed `@unnotator/plugin-api`.
- **One write path.** Project data changes only through a single Rust command layer. Extensions, in JavaScript or Python, never touch the database directly.
- **Local only.** The app makes no external network requests. The Content Security Policy is locked down and `withGlobalTauri` is off.

## Repository layout

| Path | Purpose |
| --- | --- |
| `crates/core` | Project data and database schema (Rust library, no Tauri dependency) |
| `crates/extensions` | Extension manifest schema (Rust library) |
| `crates/worker` | Worker protocol for extension processes (Rust library) |
| `src-tauri` | The Tauri application |
| `src/` | SolidJS shell. Talks to Rust through `src/ipc/` |
| `packages/plugin-api` | `@unnotator/plugin-api`: TypeScript types for extension authors |
| `config/` | Tool configuration (Vite, Vitest, Biome, Clippy) |
| `scripts/` | Repository scripts (checks, measurements) |
| `docs/` | Documentation, including the Japanese README |

Dependencies point one way: `src-tauri → crates/*`, and `worker → extensions → core`.

## Getting started

### Prerequisites

| Tool | Version |
| --- | --- |
| Rust | pinned by `rust-toolchain.toml` (installed automatically by rustup) |
| Node.js | 24 or later |
| pnpm | 10.x, enabled through `corepack` |

Tauri needs a few OS packages:

- **macOS:** Xcode Command Line Tools (`xcode-select --install`)
- **Linux:** WebKitGTK and friends, e.g. on Debian/Ubuntu: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev`
- **Windows:** Microsoft C++ Build Tools (MSVC) and WebView2

### Install and run

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm tauri dev
```

If `corepack enable` fails with a permissions error, use `corepack enable --install-directory <writable dir on your PATH> pnpm`.

## Project folders

A project is a folder. unnotator keeps its data in `.unnotator/` inside it, so you can move, copy or zip the folder and open it anywhere.

- `.unnotator/project.db` is the project database. `.unnotator/lock` stops a second app (or window) from opening the same project at the same time; if the app crashes, the operating system releases the lock, so there is nothing to clean up. The lock is reliable on local disks; on network drives the operating system may not guarantee it, so keep projects on a local disk.
- When an update changes the database format, the project is migrated automatically when you open it, and the previous contents are kept as `.unnotator/project.db.bak`. A project from a newer app is refused (and left untouched) rather than opened.
- While a project is open, your edits go to a working copy that the app keeps in its own data folder (`recovery/`), together with a change journal; `project.db` changes only when you save, and a save writes a new file next to it and swaps it in, so a crash or power loss in the middle of a save cannot leave a half-written project. You can keep editing while a save is running.
- When you close a project with unsaved changes you choose between saving and discarding (or you do not close it). If the app crashes, the next time you open the project it offers to restore the unsaved work (with the number of changes and the time of the last one) or discard it; nothing is deleted until you choose, and the undo history is rebuilt (up to 500 steps). Working data whose project no longer exists is deleted automatically after 30 days; it can also be listed and deleted by hand.

## Development

Run all six checks before considering any change done:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm schema:check
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

| Command | What it checks |
| --- | --- |
| `pnpm lint` | Biome, plus dependency direction and workspace-level dependency versions |
| `pnpm typecheck` | The shell and the contract TypeScript files, in strict mode |
| `pnpm test` | Vitest |
| `pnpm schema:check` | Contracts: DB schemas apply to an empty database, manifest fixtures validate, contract types compile, `@unnotator/plugin-api` packs and works for a consumer |
| `cargo clippy ...` | Rust static analysis; warnings are errors |
| `cargo test --workspace` | Rust tests, including a check that `src/ipc/bindings.ts` is up to date |

Other commands:

| Command | What it does |
| --- | --- |
| `pnpm tauri build --no-bundle` | Build the app binary |
| `pnpm measure:startup` | Launch the built app five times and report median and max startup time |
| `pnpm ipc:gen` | Regenerate `src/ipc/bindings.ts` after changing Rust commands |

### Contracts

Five files are the source of truth for the interfaces between parts of the system. Changes to them need a deliberate proposal, not a drive-by edit:

- `crates/core/migrations/{project,recovery}/*.sql`
- `crates/extensions/schema/unnotator-plugin.schema.json`
- `crates/worker/protocol/protocol.ts`
- `packages/plugin-api/index.d.ts`

### Conventions

- Rust: no `unwrap()` outside tests, errors with `thiserror`, logging with `tracing`.
- TypeScript: no `any`; user-facing strings go through i18n (Japanese and English); colors come from theme CSS variables.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).


## License

[MIT](LICENSE)
