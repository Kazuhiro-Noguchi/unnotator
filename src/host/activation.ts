// 拡張機能の有効化（lazy activation）と終了処理（data-model.md の `ExtensionRuntime`・`Registrations`）。
// 枠の生成や `activate` の呼び出しは `deps.start` / `deps.stop` に任せる（frames.ts を使う）。

export type RuntimeStatus =
  | "inactive"
  | "activating"
  | "active"
  | "failed"
  | "disabled";

export type ActivationFailureCode =
  | "MissingDependency"
  | "VersionMismatch"
  | "Cycle"
  | "DependencyFailed"
  | "StartFailed";

export class ActivationFailure extends Error {
  constructor(
    readonly code: ActivationFailureCode,
    message: string,
    readonly extensionId?: string,
  ) {
    super(message);
    this.name = "ActivationFailure";
  }
}

export interface RuntimeState {
  status: RuntimeStatus;
  failure?: ActivationFailure;
}

/** マニフェストから、有効化に要る部分だけを取り出したもの。 */
export interface ExtensionDescriptor {
  id: string;
  version: string;
  activationEvents: string[];
  /** `extensionDependencies`: 拡張機能 ID → 版の範囲。 */
  dependencies: Record<string, string>;
  /** 利用者が有効にしているか（無効・依存先の無効を含まない）。 */
  enabled: boolean;
}

export interface ActivationDeps {
  /** 裏の枠を作り、モジュールを読み込み、`activate` が終わるまで待つ。失敗したら例外。 */
  start(id: string): Promise<void>;
  /** `deactivate` を呼び、枠を取り除く。応答しないことがある。 */
  stop(id: string): Promise<void>;
  satisfies(range: string, version: string): boolean;
}

export interface Disposable {
  dispose(): void;
}

interface Entry {
  extId: string;
  kind: string;
  key: string;
  disposable: Disposable;
}

/** 拡張機能ごとの登録（コマンド・アイテム提供・種別など）。止めたとき、まとめて取り消す（FR-004）。 */
export class Registrations {
  private readonly entries = new Map<string, Entry>();

  private static id(kind: string, key: string): string {
    return `${kind}\u0000${key}`;
  }

  /** 登録する。同じ種類・同じ名前が既にあれば、あとから来た方を拒む（既存を壊さない）。 */
  add(
    extId: string,
    kind: string,
    key: string,
    disposable: Disposable,
  ): Disposable {
    const id = Registrations.id(kind, key);
    if (this.entries.has(id)) {
      throw new Error(`${kind} "${key}" is already registered`);
    }
    const entry: Entry = { extId, kind, key, disposable };
    this.entries.set(id, entry);
    return {
      dispose: () => {
        if (this.entries.get(id) !== entry) return;
        this.entries.delete(id);
        entry.disposable.dispose();
      },
    };
  }

  owner(kind: string, key: string): string | undefined {
    return this.entries.get(Registrations.id(kind, key))?.extId;
  }

  keys(extId: string): string[] {
    return [...this.entries.values()]
      .filter((e) => e.extId === extId)
      .map((e) => `${e.kind}:${e.key}`);
  }

  /** 拡張機能の登録をすべて取り消す。途中の例外は、残りの取り消しを止めない。 */
  disposeAll(extId: string): void {
    for (const [id, entry] of [...this.entries]) {
      if (entry.extId !== extId) continue;
      this.entries.delete(id);
      try {
        entry.disposable.dispose();
      } catch {
        // 取り消しの失敗は、ほかの取り消しに影響させない。
      }
    }
  }
}

export interface DeactivateOptions {
  /** `deactivate` を待つ時間。既定は 5 秒。 */
  timeoutMs?: number;
}

type Listener = (id: string, state: RuntimeState) => void;

const DEACTIVATE_TIMEOUT_MS = 5000;

export class ActivationManager {
  readonly registrations = new Registrations();
  private readonly descriptors = new Map<string, ExtensionDescriptor>();
  private readonly states = new Map<string, RuntimeState>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly deps: ActivationDeps) {}

  /** マニフェストの一覧を反映する。有効な状態を持つものは、そのまま残す。 */
  setExtensions(list: ExtensionDescriptor[]): void {
    this.descriptors.clear();
    for (const d of list) this.descriptors.set(d.id, d);
  }

  state(id: string): RuntimeState {
    const descriptor = this.descriptors.get(id);
    if (descriptor !== undefined && !descriptor.enabled) {
      return { status: "disabled" };
    }
    return this.states.get(id) ?? { status: "inactive" };
  }

  onDidChange(listener: Listener): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  /** 活性化イベントに一致する拡張機能を、依存順に有効にする。 */
  async trigger(event: string): Promise<void> {
    const targets = [...this.descriptors.values()].filter(
      (d) => d.enabled && d.activationEvents.includes(event),
    );
    await Promise.all(targets.map((d) => this.activate(d.id)));
  }

  /** 有効にする。同時に何度呼んでも 1 回。失敗は状態に残り、例外は投げない。 */
  async activate(id: string, options: { retry?: boolean } = {}): Promise<void> {
    if (options.retry && this.states.get(id)?.status === "failed") {
      this.states.delete(id);
    }
    try {
      await this.ensure(id, []);
    } catch {
      // 理由は状態（failed）に保持している。
    }
  }

  private set(id: string, state: RuntimeState): void {
    this.states.set(id, state);
    for (const listener of [...this.listeners]) listener(id, state);
  }

  private fail(id: string, failure: ActivationFailure): ActivationFailure {
    this.set(id, { status: "failed", failure });
    return failure;
  }

  private ensure(id: string, stack: string[]): Promise<void> {
    if (stack.includes(id)) {
      const failure = new ActivationFailure(
        "Cycle",
        `dependency cycle: ${[...stack, id].join(" -> ")}`,
        id,
      );
      return Promise.reject(this.fail(id, failure));
    }
    const descriptor = this.descriptors.get(id);
    if (descriptor === undefined) {
      return Promise.reject(
        new ActivationFailure(
          "MissingDependency",
          `unknown extension: ${id}`,
          id,
        ),
      );
    }
    if (!descriptor.enabled) {
      return Promise.reject(
        new ActivationFailure("DependencyFailed", `${id} is disabled`, id),
      );
    }
    const current = this.states.get(id);
    if (current?.status === "active") return Promise.resolve();
    if (current?.status === "failed" && current.failure !== undefined) {
      return Promise.reject(current.failure);
    }
    const running = this.inFlight.get(id);
    if (running !== undefined) return running;

    const promise = this.run(descriptor, [...stack, id]).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, promise);
    return promise;
  }

  private async run(d: ExtensionDescriptor, stack: string[]): Promise<void> {
    this.set(d.id, { status: "activating" });

    // 依存先を調べる。何も起動する前に、見つからない・版が合わない・無効、を見つける。
    for (const [depId, range] of Object.entries(d.dependencies)) {
      const dep = this.descriptors.get(depId);
      if (dep === undefined) {
        throw this.fail(
          d.id,
          new ActivationFailure(
            "MissingDependency",
            `${d.id} needs ${depId}, which is not installed`,
            depId,
          ),
        );
      }
      if (!this.deps.satisfies(range, dep.version)) {
        throw this.fail(
          d.id,
          new ActivationFailure(
            "VersionMismatch",
            `${d.id} needs ${depId} ${range}, found ${dep.version}`,
            depId,
          ),
        );
      }
      if (!dep.enabled) {
        throw this.fail(
          d.id,
          new ActivationFailure(
            "DependencyFailed",
            `${d.id} needs ${depId}, which is disabled`,
            depId,
          ),
        );
      }
    }

    // 依存先を先に有効にする。
    for (const depId of Object.keys(d.dependencies)) {
      try {
        await this.ensure(depId, stack);
      } catch (error) {
        const inner = error instanceof ActivationFailure ? error : undefined;
        throw this.fail(
          d.id,
          inner?.code === "Cycle"
            ? inner
            : new ActivationFailure(
                "DependencyFailed",
                `${d.id} needs ${depId}, which failed: ${inner?.message ?? String(error)}`,
                depId,
              ),
        );
      }
    }

    try {
      await this.deps.start(d.id);
    } catch (error) {
      throw this.fail(
        d.id,
        new ActivationFailure(
          "StartFailed",
          error instanceof Error ? error.message : String(error),
          d.id,
        ),
      );
    }
    this.set(d.id, { status: "active" });
  }

  /** 終了処理。`deactivate` が応答しなくても、時間切れのあとに登録を消して枠を取り除く。 */
  async deactivate(id: string, options: DeactivateOptions = {}): Promise<void> {
    const status = this.states.get(id)?.status;
    if (status !== "active" && status !== "activating") return;
    const timeoutMs = options.timeoutMs ?? DEACTIVATE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.deps.stop(id),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } catch {
      // `deactivate` の失敗でも、取り消しは続ける。
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.registrations.disposeAll(id);
    this.states.delete(id);
    this.inFlight.delete(id);
    this.set(id, { status: "inactive" });
  }

  /** 利用者が無効にした。止めて、以後の有効化を受けない。 */
  async disable(id: string): Promise<void> {
    await this.deactivate(id);
    const d = this.descriptors.get(id);
    if (d !== undefined) this.descriptors.set(id, { ...d, enabled: false });
    this.set(id, { status: "disabled" });
  }

  /** プロジェクトを閉じる・アプリを終えるとき。 */
  async deactivateAll(options: DeactivateOptions = {}): Promise<void> {
    const ids = [...this.states]
      .filter(([, s]) => s.status === "active" || s.status === "activating")
      .map(([id]) => id);
    await Promise.all(ids.map((id) => this.deactivate(id, options)));
  }
}
