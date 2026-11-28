// 枠の中の `Host` / `SurfaceHost`。呼び出しは `req` に変える。送り主の ID は載せない（本体が port で決める）。
// メソッドの名前は、本体と共有の権限表（Host API の名前の一覧）から作る。
import permissions from "../../../crates/extensions/host-api-permissions.json";
import type { Mirror } from "./mirror";

export interface InitExtension {
  id: string;
  version: string;
  path: string;
}

export interface HostProxyDeps {
  ext: InitExtension;
  mirror: Mirror;
  locale: string;
  messages: Record<string, string>;
  /** `unno://localhost` または `http://unno.localhost` */
  base: string;
  /** Host API の呼び出し。本体へ `req` を送り、応答を待つ。 */
  request(method: string, args: unknown): Promise<unknown>;
  /** 本体への報告（ログなど）。 */
  report(kind: "log", value: unknown): void;
}

/** 本体からの `call`（provider・コマンドなど）の受け口。 */
export type RegistryKind = string;
export interface Registry {
  /** `invoke` の呼び出しを処理する。 */
  invoke(
    kind: RegistryKind,
    localId: string,
    member: string | undefined,
    args: unknown[],
  ): Promise<unknown>;
}

type Anything = Record<string, unknown>;

const methodNames = Object.keys(permissions.methods);

/** 写しから返す同期のメソッド。 */
function syncMethods(
  d: HostProxyDeps,
): Record<string, (...a: unknown[]) => unknown> {
  const { mirror } = d;
  return {
    "selection.get": () => mirror.get("selection"),
    "labels.active": () => mirror.get("labels.active"),
    "assets.current": () => mirror.get("assets.current"),
    "tools.active": () => mirror.get("tools.active"),
    "settings.get": (key: unknown) => {
      const all = (mirror.get("settings") ?? {}) as Anything;
      return typeof key === "string" ? all[key] : all;
    },
    "assets.url": (id: unknown) => `${d.base}/asset/${String(id)}`,
    "i18n.t": (key: unknown, vars: unknown) => {
      const template = d.messages[String(key)] ?? String(key);
      const v = (vars ?? {}) as Anything;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        name in v ? String(v[name]) : `{${name}}`,
      );
    },
  };
}

const EVENT_KEYS: Record<string, string> = {
  "selection.onDidChange": "selection",
  "labels.onDidChangeActive": "labels.active",
  "labels.onDidChange": "labels.change",
  "assets.onDidChangeCurrent": "assets.current",
  "annotations.onDidChange": "annotations.change",
  "tools.onDidChange": "tools.active",
  "settings.onDidChange": "settings",
};

/** 関数の値（`impl` の関数メンバー）の名前を取り出す。 */
function memberNames(impl: unknown): string[] {
  if (typeof impl !== "object" || impl === null) return [];
  return Object.entries(impl)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k);
}

export function createHost(deps: HostProxyDeps): {
  host: Anything;
  registry: Registry;
} {
  const handlers = new Map<string, unknown>();
  const sync = syncMethods(deps);
  const host: Anything = { extension: deps.ext };
  const ns = (name: string): Anything => {
    const existing = host[name];
    if (existing !== undefined) return existing as Anything;
    const created: Anything = {};
    host[name] = created;
    return created;
  };

  for (const full of methodNames) {
    const dot = full.indexOf(".");
    if (dot < 0) continue; // `extension`・`log`
    const space = full.slice(0, dot);
    const name = full.slice(dot + 1);
    const target = ns(space);

    if (name === "register") {
      target[name] = (localId: string, impl: unknown) => {
        handlers.set(`${space}:${localId}`, impl);
        // 登録はホストが宣言と照らして決める。拒否されたら、ログに残す（例外にはしない）。
        deps
          .request(full, { localId, members: memberNames(impl) })
          .catch((error: unknown) =>
            deps.report("log", {
              level: "error",
              args: [
                `${full}(${localId}) was rejected: ${error instanceof Error ? error.message : String(error)}`,
              ],
            }),
          );
        return { dispose: () => void handlers.delete(`${space}:${localId}`) };
      };
    } else if (full in EVENT_KEYS) {
      const key = EVENT_KEYS[full] as string;
      target[name] = (listener: (v: unknown) => void) =>
        deps.mirror.on(key, listener);
    } else if (full === "selection.set") {
      target[name] = (ids: unknown) => {
        deps.mirror.apply("selection", ids); // 楽観。食い違えばホストの差分で上書きされる。
        return deps.request(full, [ids]);
      };
    } else if (full === "annotations.transaction") {
      // 関数は枠の外へ渡せない。begin → fn → commit に分け、途中の書き込みはホストが溜めて 1 回で適用する。
      target[name] = async (label: unknown, fn: unknown) => {
        if (typeof fn !== "function")
          throw new TypeError("fn must be a function");
        await deps.request(full, { op: "begin", label: String(label) });
        let result: unknown;
        try {
          result = await (fn as () => unknown)();
        } catch (error) {
          await deps.request(full, { op: "abort" }).catch(() => {});
          throw error;
        }
        await deps.request(full, { op: "commit" });
        return result;
      };
    } else if (full === "i18n.locale") {
      Object.defineProperty(target, "locale", {
        get: () => deps.locale,
        enumerable: true,
      });
    } else if (full in sync) {
      target[name] = sync[full];
    } else if (full === "assets.readText") {
      // 文字への変換は枠の中で行う。ホストには `assets.read`（バイト列）だけを送る。
      target[name] = async (id: unknown, encoding?: unknown) => {
        const label = typeof encoding === "string" ? encoding : "utf-8";
        let converter: TextDecoder;
        try {
          converter = new TextDecoder(label);
        } catch {
          throw Object.assign(new Error(`unknown encoding: ${label}`), {
            code: "ValidationFailed",
          });
        }
        const bytes = (await deps.request("assets.read", [id])) as ArrayBuffer;
        return converter.decode(bytes);
      };
    } else if (full === "extensions.getApi") {
      target[name] = async (id: string) => {
        const members = (await deps.request(full, { id })) as string[];
        const api: Anything = {};
        for (const path of members) {
          api[path] = (...args: unknown[]) =>
            deps.request(full, { id, call: path, args });
        }
        return api;
      };
    } else {
      target[name] = (...args: unknown[]) => deps.request(full, args);
    }
  }

  host.log = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (...args: unknown[]) =>
        deps.report("log", { level, args: args.map(String) }),
    ]),
  );

  const registry: Registry = {
    async invoke(kind, localId, member, args) {
      const impl = handlers.get(`${kind}:${localId}`);
      if (impl === undefined)
        throw new Error(`not registered: ${kind}/${localId}`);
      if (member === undefined) {
        if (typeof impl !== "function") throw new Error("not callable");
        return await (impl as (...a: unknown[]) => unknown)(...args);
      }
      const fn = (impl as Anything)[member];
      if (typeof fn !== "function") throw new Error(`no member: ${member}`);
      return await (fn as (...a: unknown[]) => unknown).apply(impl, args);
    },
  };
  return { host, registry };
}
