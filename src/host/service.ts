// 拡張機能ホストの全体（US1）: 登録簿の一覧を `ActivationManager` に反映し、
// 裏の枠の生成・`activate` の完了待ち・終了処理を結ぶ。
import { ActivationManager, type ExtensionDescriptor } from "./activation";
import type { HostRequest } from "./channel";
import {
  createFrameManager,
  type Frame,
  type FrameManager,
  type FrameManagerOptions,
} from "./frames";
import { versionSatisfies } from "./semver";

/** 005 の `extension_list` + `extension_get` を合わせたもの。 */
export interface ExtensionInfo {
  id: string;
  version: string;
  /** `enabled` / `disabled` / `invalid` */
  status: string;
  /** 参照を解決したマニフェスト（JSON の文字列）。有効でないものは無いことがある。 */
  manifest: string | null;
}

export interface ExtensionHostDeps {
  list(): Promise<ExtensionInfo[]>;
  doc: Document;
  /** 裏の枠を置く場所（画面には出さない）。 */
  container: HTMLElement;
  /** `unno://localhost` または `http://unno.localhost` */
  base: string;
  locale(): string;
  /** 枠からの Host API の呼び出し。 */
  handle(request: HostRequest): Promise<unknown>;
  /** 利用者に知らせる・問題ビューに出す。 */
  report(level: "error" | "warn", text: string, extensionId: string): void;
  /** `activate` の完了を待つ時間。既定は 30 秒。 */
  startTimeoutMs?: number;
  /** `deactivate` の完了を待つ時間。既定は 5 秒。 */
  stopTimeoutMs?: number;
  deliverInit?: FrameManagerOptions["deliverInit"];
  /** 裏の枠の最初の写し（`init.mirror`）。失敗したら既定の値で始める。 */
  mirrorInit?(extensionId: string): Promise<Record<string, unknown>>;
  /** 枠ができた・取り除かれたとき（写しの購読を結ぶ）。 */
  onFrameCreate?: FrameManagerOptions["onCreate"];
  onFrameRemove?: FrameManagerOptions["onRemove"];
  /** 枠の `host.log` の報告（拡張機能 ID つき）。 */
  onLog?(extensionId: string, value: unknown): void;
}

const DEFAULT_MIRROR: Record<string, unknown> = {
  selection: [],
  "labels.active": null,
  settings: {},
  "assets.current": null,
  "tools.active": null,
};

export interface ExtensionHost {
  readonly manager: ActivationManager;
  readonly frames: FrameManager;
  /** 登録簿の一覧を読み直す。無効・削除になったものは止める。 */
  refresh(): Promise<void>;
  /** 最後に読んだ一覧（画面の宣言の元）。 */
  infos(): readonly ExtensionInfo[];
  /** `refresh` で一覧を読み直すたびに呼ばれる。解除する関数を返す。 */
  onDidRefresh(listener: (infos: readonly ExtensionInfo[]) => void): () => void;
  /** 起動時: 一覧を読み、`onStartup` の拡張機能を有効にする。 */
  startup(): Promise<void>;
  trigger(event: string): Promise<void>;
  /** プロジェクトを閉じる・アプリを終えるとき。 */
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
}

interface Parsed {
  descriptor: ExtensionDescriptor;
  main: string | undefined;
}

function parse(info: ExtensionInfo): Parsed | null {
  if (info.manifest === null) return null;
  try {
    const m = JSON.parse(info.manifest) as Record<string, unknown>;
    const events = Array.isArray(m.activationEvents)
      ? m.activationEvents.filter((e): e is string => typeof e === "string")
      : [];
    const deps =
      typeof m.extensionDependencies === "object" &&
      m.extensionDependencies !== null
        ? Object.fromEntries(
            Object.entries(m.extensionDependencies).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : {};
    return {
      descriptor: {
        id: info.id,
        version: info.version,
        activationEvents: events,
        dependencies: deps,
        enabled: info.status === "enabled",
      },
      main: typeof m.main === "string" ? m.main : undefined,
    };
  } catch {
    return null;
  }
}

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
}

export function createExtensionHost(deps: ExtensionHostDeps): ExtensionHost {
  const mains = new Map<string, string | undefined>();
  const waiters = new Map<string, Waiter>();
  let lastList: readonly ExtensionInfo[] = [];
  const refreshListeners = new Set<(infos: readonly ExtensionInfo[]) => void>();
  const startTimeoutMs = deps.startTimeoutMs ?? 30_000;
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5000;

  const onReport = (
    frame: Frame,
    kind: "error" | "log" | "ready",
    value: unknown,
  ) => {
    const waiter = waiters.get(frame.extensionId);
    if (kind === "log") {
      deps.onLog?.(frame.extensionId, value);
    } else if (kind === "ready") {
      waiter?.resolve();
    } else if (kind === "error") {
      const message =
        typeof value === "object" && value !== null && "message" in value
          ? String((value as { message: unknown }).message)
          : String(value);
      if (waiter !== undefined) waiter.reject(new Error(message));
      else deps.report("error", message, frame.extensionId);
    }
  };

  const frames = createFrameManager({
    doc: deps.doc,
    base: deps.base,
    handle: deps.handle,
    onReport,
    ...(deps.onFrameCreate === undefined ? {} : { onCreate: deps.onFrameCreate }),
    ...(deps.onFrameRemove === undefined ? {} : { onRemove: deps.onFrameRemove }),
    ...(deps.deliverInit === undefined
      ? {}
      : { deliverInit: deps.deliverInit }),
  });

  async function start(id: string): Promise<void> {
    const main = mains.get(id);
    if (main === undefined) throw new Error(`${id} has no main`);
    const descriptorVersion = manager.versionOf(id);
    const ready = new Promise<void>((resolve, reject) => {
      waiters.set(id, { resolve, reject });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${id} did not become ready`)),
        startTimeoutMs,
      );
    });
    let mirror = DEFAULT_MIRROR;
    try {
      mirror = (await deps.mirrorInit?.(id)) ?? DEFAULT_MIRROR;
    } catch {
      // 写しの元が読めなくても、枠は始める（差分で追いつく）。
    }
    frames.create({
      extensionId: id,
      role: "background",
      container: deps.container,
      init: {
        ext: { id, version: descriptorVersion, path: "" },
        url: `${deps.base}/ext/${id}/${main.replace(/^\/+/, "")}`,
        locale: deps.locale(),
        messages: {},
        theme: {},
        mirror: { ...DEFAULT_MIRROR, ...mirror },
        ctx: {},
      },
    });
    try {
      await Promise.race([ready, timeout]);
    } catch (error) {
      frames.removeAll(id);
      deps.report(
        "error",
        error instanceof Error ? error.message : String(error),
        id,
      );
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      waiters.delete(id);
    }
  }

  async function disposeSurfaces(id: string): Promise<void> {
    const surfaces = frames.framesOf(id).filter((f) => f.role !== "background");
    if (surfaces.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, stopTimeoutMs);
    });
    try {
      await Promise.race([
        Promise.allSettled(
          surfaces.map((f) => f.channel.call("dispose", null)),
        ),
        limit,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function stop(id: string): Promise<void> {
    const frame = frames.background(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 画面の枠（エディター・ビュー）には、先に `dispose` を送る（書きかけの内容を Host API で残せるように）。
    if (frames.framesOf(id).some((f) => f.role !== "background"))
      await disposeSurfaces(id);
    try {
      if (frame !== undefined) {
        await Promise.race([
          frame.channel.call("deactivate", null),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, stopTimeoutMs);
          }),
        ]);
      }
    } catch {
      // `deactivate` の失敗でも、枠は取り除く。
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      frames.removeAll(id);
    }
  }

  const manager = new ActivationManager({
    start,
    stop,
    satisfies: versionSatisfies,
  });

  async function refresh(): Promise<void> {
    const list = await deps.list();
    lastList = list;
    const descriptors: ExtensionDescriptor[] = [];
    mains.clear();
    for (const info of list) {
      const parsed = parse(info);
      if (parsed === null) continue;
      descriptors.push(parsed.descriptor);
      mains.set(info.id, parsed.main);
    }
    const stillEnabled = new Set(
      descriptors.filter((d) => d.enabled).map((d) => d.id),
    );
    const running = frames.backgroundIds();
    manager.setExtensions(descriptors);
    for (const listener of [...refreshListeners]) listener(list);
    await Promise.all(
      running
        .filter((id) => !stillEnabled.has(id))
        .map(async (id) => {
          await manager.deactivate(id, { timeoutMs: stopTimeoutMs });
        }),
    );
  }

  return {
    manager,
    frames,
    refresh,
    infos: () => lastList,
    onDidRefresh(listener) {
      refreshListeners.add(listener);
      return () => refreshListeners.delete(listener);
    },
    async startup() {
      await refresh();
      await manager.trigger("onStartup");
    },
    trigger: (event) => manager.trigger(event),
    shutdown: (options) =>
      manager.deactivateAll({ timeoutMs: options?.timeoutMs ?? stopTimeoutMs }),
  };
}

export type { FrameManager };
