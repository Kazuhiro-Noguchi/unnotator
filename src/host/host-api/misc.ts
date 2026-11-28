// そのほかの Host API: 登録（`*.register`）・`commands`・`tools`・`ui`・`context`・`storage`・`projectFiles`・`python`。
// 宣言のないもの（種別・コマンド・ステータスバー項目・ビュー）は、実行時に拒否する（FR-031）。
// 表示する文字列は、拡張機能が決めても、ホストが文字として描き、長さを制限する。
import type { Ctx, Handlers } from "./api-types";
import { invalid, obj, optObj, optStr, positional, str } from "./convert";
import type { StorageScopeDto } from "./ipc";
import { HostApiError } from "./permissions";

/** `ui.notify` の本文の長さの上限。 */
export const MAX_NOTIFY_CHARS = 500;
export const MAX_CONFIRM_CHARS = 1000;
export const MAX_LABEL_CHARS = 40;
export const MAX_STATUS_TEXT_CHARS = 200;
export const MAX_STATUS_TOOLTIP_CHARS = 500;
/** `storage` の 1 つの値の大きさの上限（文字数）。 */
export const MAX_STORAGE_VALUE_CHARS = 1024 * 1024;
/** `projectFiles.write` の 1 回の大きさの上限（バイト）。 */
export const MAX_PROJECT_FILE_BYTES = 16 * 1024 * 1024;
/** 1 つの拡張機能が持てるコンテキストのキーの数。 */
export const MAX_CONTEXT_KEYS = 200;

type Kind =
  | "annotationTypes"
  | "items"
  | "exporters"
  | "importers"
  | "commands";

/** 登録の種類 → マニフェストで宣言する名前の置き場。 */
const DECLARED: Record<
  Kind,
  "annotationTypes" | "itemProviders" | "exporters" | "importers" | "commands"
> = {
  annotationTypes: "annotationTypes",
  items: "itemProviders",
  exporters: "exporters",
  importers: "importers",
  commands: "commands",
};

const SCREEN_REGISTERS = new Set(["editors", "previewers", "views"]);

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function localName(v: unknown, name: string): string {
  const text = str(v, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(text))
    throw invalid(`${name} is not a valid local name`);
  return text;
}

function qualifiedId(v: unknown, name: string): string {
  const text = str(v, name);
  if (text.length > 300) throw invalid(`${name} is too long`);
  return text;
}

function toBytes(data: unknown): number[] {
  if (typeof data === "string") return [...new TextEncoder().encode(data)];
  if (data instanceof ArrayBuffer) return [...new Uint8Array(data)];
  if (ArrayBuffer.isView(data))
    return [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
  throw invalid("data must be a string or an ArrayBuffer");
}

function storageScope(raw: unknown): StorageScopeDto {
  const s = optObj(raw, "scope");
  const assetId = optStr(s?.assetId, "assetId");
  const itemKey = optStr(s?.itemKey, "itemKey");
  if (assetId === undefined && itemKey !== undefined)
    throw invalid("itemKey needs assetId");
  if (assetId === undefined) return { kind: "project", id: "" };
  if (assetId === "" || assetId.includes("/"))
    throw invalid("assetId is invalid");
  if (itemKey === undefined) return { kind: "asset", id: assetId };
  return { kind: "item", id: `${assetId}/${itemKey}` };
}

function storageKey(v: unknown): string {
  const key = str(v, "key");
  if (key === "" || key.length > 200) throw invalid("key is invalid");
  return key;
}

export function createMiscHandlers(): Handlers {
  const contextKeys = new Map<string, Set<string>>();

  /** 登録の共通の処理。宣言の確認 → `Registrations`（二重登録の拒否・取り消しの結び）。 */
  function register(kind: Kind) {
    return async (ctx: Ctx, a: unknown): Promise<null> => {
      const payload = obj(a, "registration");
      const local = localName(payload.localId, "localId");
      const members = Array.isArray(payload.members)
        ? payload.members.filter((m): m is string => typeof m === "string")
        : payload.members === undefined
          ? []
          : (() => {
              throw invalid("members must be an array");
            })();
      const facts = ctx.deps.manifests.get(ctx.extId);
      const declared = facts?.contributes[DECLARED[kind]] ?? [];
      if (!declared.includes(local))
        throw invalid(`${kind}/${local} is not declared in the manifest`);

      if (
        ctx.deps.registrations().owner(kind, `${ctx.extId}/${local}`) !==
        undefined
      )
        throw invalid(`${kind}/${local} is already registered`);
      const memberKey = `${ctx.extId}\u0000${local}`;
      let inner: { dispose(): void } = { dispose() {} };
      if (kind === "commands") {
        inner = ctx.deps.shell.provideCommand(`${ctx.extId}/${local}`, (args) =>
          ctx.deps.callFrame(ctx.extId, "invoke", {
            kind: "commands",
            localId: local,
            args: [args],
          }),
        );
      }
      try {
        ctx.deps.registrations().add(ctx.extId, kind, `${ctx.extId}/${local}`, {
          dispose() {
            ctx.deps.members.delete(memberKey);
            inner.dispose();
          },
        });
      } catch (error) {
        inner.dispose();
        throw invalid(
          error instanceof Error ? error.message : "already registered",
        );
      }
      ctx.deps.members.set(memberKey, members);
      return null;
    };
  }

  const handlers: Handlers = {
    "annotationTypes.register": register("annotationTypes"),
    "items.register": register("items"),
    "exporters.register": register("exporters"),
    "importers.register": register("importers"),
    "commands.register": register("commands"),

    "commands.execute": async (ctx, a) => {
      const [id, args] = positional(a);
      const result = await ctx.deps.shell.executeCommand(
        qualifiedId(id, "id"),
        args,
      );
      if (result.ok) return result.value ?? null;
      if (result.reason === "unknown")
        throw new HostApiError("NotFound", "command not found");
      throw new HostApiError("Internal", `command failed: ${result.reason}`);
    },

    "tools.activate": async (ctx, a) => {
      const [id] = positional(a);
      if (id === null || id === undefined) {
        ctx.deps.state.set("tools.active", null);
        return null;
      }
      const tool = qualifiedId(id, "id");
      const known = ctx.deps.manifests
        .all()
        .some((m) =>
          m.contributes.tools.some((local) => `${m.id}/${local}` === tool),
        );
      if (!known) throw new HostApiError("NotFound", "tool not found");
      ctx.deps.state.set("tools.active", tool);
      return null;
    },

    "ui.notify": async (ctx, a) => {
      const [message, level] = positional(a);
      const lv = level === undefined ? "info" : level;
      if (lv !== "info" && lv !== "warn" && lv !== "error")
        throw invalid("level is invalid");
      ctx.deps.shell.notify(
        lv,
        clip(str(message, "message"), MAX_NOTIFY_CHARS),
        ctx.extId,
      );
      return null;
    },
    "ui.confirm": async (ctx, a) => {
      const [message, opts] = positional(a);
      const o = optObj(opts, "options");
      const ok = optStr(o?.okLabel, "okLabel");
      const cancel = optStr(o?.cancelLabel, "cancelLabel");
      return await ctx.deps.shell.confirm({
        extId: ctx.extId,
        message: clip(str(message, "message"), MAX_CONFIRM_CHARS),
        okLabel: ok === undefined ? undefined : clip(ok, MAX_LABEL_CHARS),
        cancelLabel:
          cancel === undefined ? undefined : clip(cancel, MAX_LABEL_CHARS),
      });
    },
    "ui.setStatusBarItem": async (ctx, a) => {
      const [idArg, item] = positional(a);
      const id = localName(idArg, "localId");
      const spec = ctx.deps.manifests.get(ctx.extId)?.statusBarItems[id];
      if (spec === undefined)
        throw invalid(`status bar item is not declared: ${id}`);
      const key = { source: ctx.extId, id };
      if (item === null || item === undefined) {
        ctx.deps.shell.setStatusBarItem(null, key);
        return null;
      }
      const o = obj(item, "item");
      const tooltip = optStr(o.tooltip, "tooltip");
      ctx.deps.shell.setStatusBarItem(
        {
          source: ctx.extId,
          id,
          alignment: spec.alignment,
          priority: spec.priority,
          text: clip(str(o.text, "text"), MAX_STATUS_TEXT_CHARS),
          ...(tooltip === undefined
            ? {}
            : { tooltip: clip(tooltip, MAX_STATUS_TOOLTIP_CHARS) }),
          ...(spec.command === undefined ? {} : { command: spec.command }),
        },
        key,
      );
      return null;
    },
    "ui.showView": async (ctx, a) => {
      const [id] = positional(a);
      const view = qualifiedId(id, "id");
      const known = ctx.deps.manifests
        .all()
        .some((m) =>
          m.contributes.views.some((local) => `${m.id}/${local}` === view),
        );
      if (!known) throw new HostApiError("NotFound", "view not found");
      ctx.deps.shell.showView(view);
      return null;
    },

    "context.set": async (ctx, a) => {
      const [keyArg, value] = positional(a);
      const key = str(keyArg, "key");
      if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw invalid("key is invalid");
      if (
        value !== null &&
        typeof value !== "boolean" &&
        !(typeof value === "number" && Number.isFinite(value)) &&
        !(typeof value === "string" && value.length <= 200)
      )
        throw invalid("value must be a short string, number, boolean or null");
      const keys = contextKeys.get(ctx.extId) ?? new Set<string>();
      if (!keys.has(key) && keys.size >= MAX_CONTEXT_KEYS)
        throw invalid("too many context keys");
      keys.add(key);
      contextKeys.set(ctx.extId, keys);
      ctx.deps.shell.setContext(ctx.extId, key, value);
      return null;
    },

    "storage.get": async (ctx, a) => {
      const [key, scope] = positional(a);
      const json = await ctx.ipc.storageGet(
        ctx.extId,
        storageScope(scope),
        storageKey(key),
      );
      if (json === null) return undefined;
      try {
        return JSON.parse(json) as unknown;
      } catch {
        return undefined;
      }
    },
    "storage.set": async (ctx, a) => {
      const [key, value, scope] = positional(a);
      if (value === undefined) throw invalid("value is required");
      const json = JSON.stringify(value);
      if (json === undefined) throw invalid("value must be JSON");
      if (json.length > MAX_STORAGE_VALUE_CHARS)
        throw invalid("value is too large");
      await ctx.ipc.storageSet(
        ctx.extId,
        storageScope(scope),
        storageKey(key),
        json,
      );
      return null;
    },

    "projectFiles.read": async (ctx, a) => {
      const [relPath] = positional(a);
      const bytes = await ctx.ipc.projectFileRead(
        ctx.extId,
        str(relPath, "relPath"),
      );
      if (bytes === null) return null;
      const out = new Uint8Array(bytes);
      return out.buffer;
    },
    "projectFiles.write": async (ctx, a) => {
      const [relPath, data] = positional(a);
      const bytes = toBytes(data);
      if (bytes.length > MAX_PROJECT_FILE_BYTES)
        throw invalid("file is too large");
      await ctx.ipc.projectFileWrite(ctx.extId, str(relPath, "relPath"), bytes);
      return null;
    },

    "python.request": async () => {
      throw new HostApiError(
        "PythonUnavailable",
        "the python worker is not available",
      );
    },
    "python.readBlob": async () => {
      throw new HostApiError(
        "PythonUnavailable",
        "the python worker is not available",
      );
    },
  };

  for (const space of SCREEN_REGISTERS) {
    handlers[`${space}.register`] = async () => {
      throw invalid(
        `${space} are declared by the manifest entry, not registered`,
      );
    };
  }
  return handlers;
}
