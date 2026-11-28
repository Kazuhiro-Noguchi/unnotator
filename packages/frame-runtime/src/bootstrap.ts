// 枠の起動用コード（contracts/host-channel.md）。
// 最初の `init`（port 付き）だけを受け、以後はその port 以外を無視する。
import { type ErrorReport, installErrorReporting, toReport } from "./errors";
import { createHost, type InitExtension } from "./host-proxy";
import { createMirror, type MirrorInit } from "./mirror";

export interface InitMessage {
  t: "init";
  ext: InitExtension;
  role: "background" | "editor" | "view" | "preview";
  /** 拡張機能のモジュールの URL（`main` または `entry`）。 */
  url: string;
  locale: string;
  messages: Record<string, string>;
  /** テーマの色の変数（`--name` → 値）。 */
  theme: Record<string, string>;
  mirror: Partial<MirrorInit>;
  base: string;
  /** 画面の文脈（`EditorContext` などの、`container` 以外）。 */
  ctx: Record<string, unknown>;
}

export interface FrameDeps {
  win: Pick<Window, "addEventListener" | "removeEventListener" | "parent">;
  doc: Document;
  importModule: (url: string) => Promise<unknown>;
}

interface Module {
  activate?: (host: unknown) => unknown;
  deactivate?: () => unknown;
  openEditor?: (ctx: unknown, host: unknown) => Promise<unknown>;
  resolveView?: (ctx: unknown, host: unknown) => Promise<unknown>;
  renderPreview?: (ctx: unknown, host: unknown) => Promise<unknown>;
}

function isInit(data: unknown): data is InitMessage {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.t === "init" &&
    typeof d.url === "string" &&
    typeof d.role === "string" &&
    typeof d.ext === "object" &&
    d.ext !== null
  );
}

/** 起動する。戻り値で、購読を外す（テスト用）。 */
export function startFrame(deps: FrameDeps): () => void {
  let started = false;
  let removeErrors: (() => void) | null = null;

  const onMessage = (event: Event) => {
    if (started) return;
    const e = event as MessageEvent;
    // 起動の合図は、親（本体）からだけ受ける。兄弟の枠からのものは無視する。
    if (e.source !== deps.win.parent) return;
    const port = e.ports?.[0];
    if (port === undefined || !isInit(e.data)) return;
    started = true;
    deps.win.removeEventListener("message", onMessage);
    void run(port, e.data);
  };

  async function run(port: MessagePort, init: InitMessage): Promise<void> {
    const post = (message: unknown) => port.postMessage(message);
    const reportError = (r: ErrorReport) =>
      post({ t: "rep", kind: "error", v: r });
    removeErrors = installErrorReporting(
      deps.win as unknown as Parameters<typeof installErrorReporting>[0],
      reportError,
    );

    for (const [name, value] of Object.entries(init.theme)) {
      deps.doc.documentElement.style.setProperty(name, value);
    }

    const mirror = createMirror(init.mirror);
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const request = (m: string, a: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        post({ t: "req", id, m, a });
      });

    const { host, registry } = createHost({
      ext: init.ext,
      mirror,
      locale: init.locale,
      messages: init.messages,
      base: init.base,
      request,
      report: (kind, v) => post({ t: "rep", kind, v }),
    });

    let mod: Module = {};
    port.onmessage = (event) => {
      const data = event.data as Record<string, unknown> | null;
      if (typeof data !== "object" || data === null) return;
      if (data.t === "ev" && typeof data.k === "string") {
        mirror.apply(data.k, data.v);
      } else if (data.t === "res" && typeof data.id === "number") {
        const p = pending.get(data.id);
        if (p === undefined) return;
        pending.delete(data.id);
        if (data.ok === true) p.resolve(data.v);
        else {
          p.reject(
            Object.assign(new Error(String(data.msg ?? "")), {
              code: String(data.code ?? "Internal"),
            }),
          );
        }
      } else if (data.t === "call" && typeof data.id === "number") {
        void answer(data.id, String(data.m), data.a);
      }
    };

    async function answer(id: number, m: string, a: unknown): Promise<void> {
      try {
        let v: unknown;
        if (m === "invoke") {
          const arg = a as {
            kind: string;
            localId: string;
            member?: string;
            args?: unknown[];
          };
          v = await registry.invoke(
            arg.kind,
            arg.localId,
            arg.member,
            arg.args ?? [],
          );
        } else if (m === "deactivate") {
          v = await mod.deactivate?.();
        } else {
          throw new Error(`unknown call: ${m}`);
        }
        post({ t: "res", id, ok: true, v: v ?? null });
      } catch (error) {
        const r = toReport("call", error);
        post({ t: "res", id, ok: false, code: "Internal", msg: r.message });
      }
    }

    try {
      mod = (await deps.importModule(init.url)) as Module;
    } catch (error) {
      reportError(toReport("import", error));
      return;
    }

    try {
      const ctx = { ...init.ctx, container: deps.doc.body };
      if (init.role === "background") await mod.activate?.(host);
      else if (init.role === "editor") await mod.openEditor?.(ctx, host);
      else if (init.role === "view") await mod.resolveView?.(ctx, host);
      else await mod.renderPreview?.(ctx, host);
    } catch (error) {
      reportError(
        toReport(init.role === "background" ? "activate" : "surface", error),
      );
      return;
    }
    post({ t: "rep", kind: "ready", v: null });
  }

  deps.win.addEventListener("message", onMessage);
  return () => {
    deps.win.removeEventListener("message", onMessage);
    removeErrors?.();
  };
}
