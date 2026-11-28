// 枠（extension frame）の生成と破棄（data-model.md の `Frame`・`FrameStats`）。
// 拡張機能ごとの裏の枠は 1 つ。画面の枠は、開くたびに作る。
import permissions from "../../crates/extensions/host-api-permissions.json";
import {
  HostChannel,
  type HostRequest,
  type PortLike,
  type RejectReason,
} from "./channel";

export type FrameRole = "background" | "editor" | "view" | "preview";

/** Host API の名前の表（本体と Rust で共有）。枠から受けてよい `m`。 */
export const HOST_METHODS: ReadonlySet<string> = new Set(
  Object.keys(permissions.methods),
);

export interface FrameStats {
  /** 検査に落ちた・失敗した回数。 */
  failures: number;
  calls: number;
  /** 直近の遅い呼び出し（> 50 ms）の数。 */
  slowCalls: number;
  createdAt: number;
}

export interface Frame {
  readonly extensionId: string;
  readonly role: FrameRole;
  readonly element: HTMLIFrameElement;
  readonly channel: HostChannel;
  readonly stats: FrameStats;
}

/** `init` のうち、本体が枠ごとに決める部分。`t`・`role`・`base` は、ここで足す。 */
export interface FrameInit {
  ext: { id: string; version: string; path: string };
  url: string;
  locale: string;
  messages: Record<string, string>;
  theme: Record<string, string>;
  mirror: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

export interface CreateFrameOptions {
  extensionId: string;
  role: FrameRole;
  container: HTMLElement;
  init: FrameInit;
}

export interface FrameManagerOptions {
  doc: Document;
  /** `unno://localhost` または `http://unno.localhost` */
  base: string;
  /** 枠からの Host API の呼び出し。送り主は port で決まった拡張機能 ID。 */
  handle: (request: HostRequest) => Promise<unknown>;
  onReport?: (
    frame: Frame,
    kind: "error" | "log" | "ready",
    value: unknown,
  ) => void;
  /** `init` を枠へ渡す。既定は `contentWindow.postMessage`。テストで差し替える。 */
  deliverInit?: (
    element: HTMLIFrameElement,
    init: unknown,
    port: MessagePort,
  ) => void;
}

export function frameSrc(base: string, id: string, role: FrameRole): string {
  return `${base}/ext/${id}/@host/frame.html?role=${role}`;
}

const SLOW_MS = 50;

function defaultDeliver(
  element: HTMLIFrameElement,
  init: unknown,
  port: MessagePort,
): void {
  // 枠は opaque origin なので、送り先の origin は指定できない。受け取るのは、この枠だけ。
  element.contentWindow?.postMessage(init, "*", [port]);
}

export interface FrameManager {
  create(options: CreateFrameOptions): Frame;
  remove(frame: Frame): void;
  removeAll(extensionId: string): void;
  framesOf(extensionId: string): Frame[];
  background(extensionId: string): Frame | undefined;
  /** 裏の枠を持つ拡張機能の ID。 */
  backgroundIds(): string[];
}

export function createFrameManager(options: FrameManagerOptions): FrameManager {
  const frames = new Map<string, Set<Frame>>();
  const deliver = options.deliverInit ?? defaultDeliver;

  const framesOf = (id: string) => [...(frames.get(id) ?? [])];
  const background = (id: string) =>
    framesOf(id).find((f) => f.role === "background");

  function create(opts: CreateFrameOptions): Frame {
    if (opts.role === "background") {
      const existing = background(opts.extensionId);
      if (existing !== undefined) return existing;
    }

    const element = options.doc.createElement("iframe");
    element.setAttribute("sandbox", "allow-scripts");
    element.setAttribute(
      "src",
      frameSrc(options.base, opts.extensionId, opts.role),
    );
    element.setAttribute("title", opts.extensionId);

    const { port1, port2 } = new MessageChannel();
    const stats: FrameStats = {
      failures: 0,
      calls: 0,
      slowCalls: 0,
      createdAt: Date.now(),
    };
    const channel = new HostChannel(port1 as unknown as PortLike, {
      extId: opts.extensionId,
      methods: HOST_METHODS,
      handle: async (request) => {
        stats.calls += 1;
        const started = Date.now();
        try {
          return await options.handle(request);
        } catch (error) {
          stats.failures += 1;
          throw error;
        } finally {
          if (Date.now() - started > SLOW_MS) stats.slowCalls += 1;
        }
      },
      onReject: (_reason: RejectReason) => {
        stats.failures += 1;
      },
      onReport: (kind, value) => {
        if (kind === "error") stats.failures += 1;
        options.onReport?.(frame, kind, value);
      },
    });
    const frame: Frame = {
      extensionId: opts.extensionId,
      role: opts.role,
      element,
      channel,
      stats,
    };

    // 最初の load でだけ `init` を渡す。以後の再読み込みでは渡さない（port は 1 回きり）。
    let delivered = false;
    element.addEventListener("load", () => {
      if (delivered) return;
      delivered = true;
      deliver(
        element,
        {
          t: "init",
          role: opts.role,
          base: options.base,
          ...opts.init,
        },
        port2,
      );
    });

    const set = frames.get(opts.extensionId) ?? new Set<Frame>();
    set.add(frame);
    frames.set(opts.extensionId, set);
    opts.container.append(element);
    return frame;
  }

  function remove(frame: Frame): void {
    frame.channel.close();
    frame.element.remove();
    const set = frames.get(frame.extensionId);
    set?.delete(frame);
    if (set?.size === 0) frames.delete(frame.extensionId);
  }

  return {
    create,
    remove,
    removeAll(extensionId) {
      for (const frame of framesOf(extensionId)) remove(frame);
    },
    framesOf,
    background,
    backgroundIds: () =>
      [...frames.keys()].filter((id) => background(id) !== undefined),
  };
}
