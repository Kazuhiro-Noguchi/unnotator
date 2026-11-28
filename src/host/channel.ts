// 本体 ↔ 枠のチャンネル（contracts/host-channel.md）。
// 送り主は、メッセージを受け取った port で決まる。封筒の中の自己申告の ID は使わない。

/** 検査の上限（初期値。計測で調整する）。 */
export const CHANNEL_LIMITS = {
  /** 1 メッセージの大きさ（`ArrayBuffer` を除く）。 */
  maxBytes: 1024 * 1024,
  maxDepth: 32,
  maxArrayLength: 10_000,
  maxPerSecond: 500,
  timeoutMs: 30_000,
} as const;

export type Envelope =
  | { t: "req"; id: number; m: string; a: unknown }
  | { t: "res"; id: number; ok: true; v: unknown }
  | { t: "res"; id: number; ok: false; code: string; msg: string; d?: unknown }
  | { t: "call"; id: number; m: string; a: unknown }
  | { t: "ev"; k: string; v: unknown }
  | { t: "rep"; kind: "error" | "log" | "ready"; v: unknown };

export type RejectReason =
  | "badShape"
  | "unknownMethod"
  | "tooLarge"
  | "tooDeep"
  | "tooLong"
  | "badValue"
  | "rateLimited"
  | "unknownResponse";

export type InspectResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; reason: RejectReason };

class Rejection extends Error {
  constructor(readonly reason: RejectReason) {
    super(reason);
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 値が構造化複製で安全に扱える純粋なデータかを調べる。入れ子・長さ・大きさ・循環・関数や DOM を拒む。 */
function checkValue(root: unknown, startDepth: number): void {
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > CHANNEL_LIMITS.maxDepth) throw new Rejection("tooDeep");
    switch (typeof value) {
      case "string":
        bytes += value.length;
        break;
      case "number":
        if (!Number.isFinite(value)) throw new Rejection("badValue");
        bytes += 8;
        break;
      case "boolean":
        bytes += 1;
        break;
      case "undefined":
        break;
      case "object": {
        if (value === null) break;
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) break;
        if (ancestors.has(value)) throw new Rejection("badValue");
        ancestors.add(value);
        if (Array.isArray(value)) {
          if (value.length > CHANNEL_LIMITS.maxArrayLength)
            throw new Rejection("tooLong");
          for (const item of value) visit(item, depth + 1);
        } else if (isPlainObject(value)) {
          for (const [key, item] of Object.entries(value)) {
            bytes += key.length;
            visit(item, depth + 1);
            if (bytes > CHANNEL_LIMITS.maxBytes)
              throw new Rejection("tooLarge");
          }
        } else {
          throw new Rejection("badValue");
        }
        ancestors.delete(value);
        break;
      }
      default:
        // function・symbol・bigint
        throw new Rejection("badValue");
    }
    if (bytes > CHANNEL_LIMITS.maxBytes) throw new Rejection("tooLarge");
  };
  visit(root, startDepth);
}

/** 値が検査の上限に収まる、構造化複製できるデータか（`getApi` の引数・戻り値の検査に使う）。 */
export function isPlainData(value: unknown): boolean {
  try {
    checkValue(value, 1);
    return true;
  } catch (error) {
    if (error instanceof Rejection) return false;
    throw error;
  }
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** 受け取ったメッセージを検査し、封筒の既知のフィールドだけを取り出す（自己申告の ID などは捨てる）。 */
export function inspectEnvelope(
  data: unknown,
  options: { methods: ReadonlySet<string> },
): InspectResult {
  try {
    if (typeof data !== "object" || data === null || Array.isArray(data))
      throw new Rejection("badShape");
    if (!isPlainObject(data)) throw new Rejection("badShape");
    const raw = data as Record<string, unknown>;
    let envelope: Envelope;
    switch (raw.t) {
      case "req": {
        if (!isId(raw.id) || typeof raw.m !== "string")
          throw new Rejection("badShape");
        if (!options.methods.has(raw.m)) throw new Rejection("unknownMethod");
        envelope = { t: "req", id: raw.id, m: raw.m, a: raw.a };
        break;
      }
      case "res": {
        if (!isId(raw.id)) throw new Rejection("badShape");
        if (raw.ok === true) {
          envelope = { t: "res", id: raw.id, ok: true, v: raw.v };
        } else if (
          raw.ok === false &&
          typeof raw.code === "string" &&
          typeof raw.msg === "string"
        ) {
          envelope =
            raw.d === undefined
              ? {
                  t: "res",
                  id: raw.id,
                  ok: false,
                  code: raw.code,
                  msg: raw.msg,
                }
              : {
                  t: "res",
                  id: raw.id,
                  ok: false,
                  code: raw.code,
                  msg: raw.msg,
                  d: raw.d,
                };
        } else {
          throw new Rejection("badShape");
        }
        break;
      }
      case "rep": {
        if (raw.kind !== "error" && raw.kind !== "log" && raw.kind !== "ready")
          throw new Rejection("badShape");
        envelope = { t: "rep", kind: raw.kind, v: raw.v };
        break;
      }
      default:
        // 枠から `call`・`ev` は受けない。
        throw new Rejection("badShape");
    }
    // 封筒そのものを 1 段目として、値の検査を行う。
    checkValue(envelope, 1);
    return { ok: true, envelope };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** 枠ごとの頻度の上限。1 秒の窓で数える。通せば true。 */
export function createRateLimiter(
  now: () => number = () => Date.now(),
  perSecond: number = CHANNEL_LIMITS.maxPerSecond,
): () => boolean {
  let windowStart = now();
  let count = 0;
  return () => {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      count = 0;
    }
    if (count >= perSecond) return false;
    count += 1;
    return true;
  };
}

/** `MessagePort` のうち、使う部分。テストで差し替えられる。 */
export interface PortLike {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
}

export class ChannelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface HostRequest {
  /** port で決まった送り主（拡張機能 ID）。 */
  extId: string;
  m: string;
  a: unknown;
}

export interface HostChannelOptions {
  extId: string;
  /** 枠から受けてよい Host API の名前の表。 */
  methods: ReadonlySet<string>;
  handle: (request: HostRequest) => Promise<unknown>;
  onReject?: (reason: RejectReason) => void;
  onReport?: (kind: "error" | "log" | "ready", value: unknown) => void;
  now?: () => number;
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: ChannelError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 本体側から見た、1 つの枠との通信。port ごとに 1 つ作る。 */
export class HostChannel {
  readonly extId: string;
  rejectedCount = 0;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private readonly allow: () => boolean;

  constructor(
    private readonly port: PortLike,
    private readonly options: HostChannelOptions,
  ) {
    this.extId = options.extId;
    this.allow = createRateLimiter(options.now);
    port.onmessage = (event) => this.receive(event.data);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** 枠の関数（provider・コマンドなど）を呼ぶ。30 秒で `Timeout`。 */
  call(m: string, a: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new ChannelError("Closed", "channel closed"));
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? CHANNEL_LIMITS.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChannelError("Timeout", `no response to ${m}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ t: "call", id, m, a });
    });
  }

  /** 写しの差分やイベントを枠へ押し込む。 */
  emit(k: string, v: unknown): void {
    if (!this.closed) this.port.postMessage({ t: "ev", k, v });
  }

  /** 枠を取り除くとき。保留中の呼び出しを失敗させ、port を閉じる。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.port.onmessage = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ChannelError("Closed", "channel closed"));
      this.pending.delete(id);
    }
    this.port.close();
  }

  private reject(reason: RejectReason): void {
    this.rejectedCount += 1;
    this.options.onReject?.(reason);
  }

  private receive(data: unknown): void {
    if (this.closed) return;
    if (!this.allow()) {
      this.reject("rateLimited");
      return;
    }
    const result = inspectEnvelope(data, { methods: this.options.methods });
    if (!result.ok) {
      this.reject(result.reason);
      return;
    }
    const env = result.envelope;
    if (env.t === "req") {
      void this.serve(env.id, env.m, env.a);
    } else if (env.t === "res") {
      const p = this.pending.get(env.id);
      if (p === undefined) {
        this.reject("unknownResponse");
        return;
      }
      clearTimeout(p.timer);
      this.pending.delete(env.id);
      if (env.ok) p.resolve(env.v);
      else p.reject(new ChannelError(env.code, env.msg, env.d));
    } else if (env.t === "rep") {
      this.options.onReport?.(env.kind, env.v);
    }
  }

  private async serve(id: number, m: string, a: unknown): Promise<void> {
    try {
      const v = await this.options.handle({ extId: this.extId, m, a });
      if (!this.closed) this.port.postMessage({ t: "res", id, ok: true, v });
    } catch (error) {
      if (this.closed) return;
      const code =
        typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : "Internal";
      const msg = error instanceof Error ? error.message : String(error);
      this.port.postMessage({ t: "res", id, ok: false, code, msg });
    }
  }
}
