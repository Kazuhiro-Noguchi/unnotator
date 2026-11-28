// 書き込みの Host API（`annotations`・`relations`・`groups`・`assets.setMetadata/setStatus`）。
// どれも `ext_apply_command` 1 本に集まる（憲章 III）。Rust 側が権限を再確認し、`source` を拡張機能 ID に固定する。
// `annotations.transaction` は、枠から begin / commit / abort で来る。commit までは本体で溜め、1 つの `Transaction` として送る。
import type { Ctx, Handlers } from "./api-types";
import {
  invalid,
  type JsonObject,
  jsonObject,
  obj,
  optObj,
  optStr,
  parseObject,
  positional,
  str,
  strList,
  uuidv7,
} from "./convert";
import type { HostIpc } from "./ipc";
import { HostApiError } from "./permissions";

type Command = Parameters<HostIpc["applyCommand"]>[1];

/** 1 つの transaction に溜められるコマンドの数。 */
export const MAX_TRANSACTION_COMMANDS = 10_000;
/** 1 回の remove などで指定できる ID の数。 */
const MAX_IDS = 10_000;

const STATUSES = new Set(["todo", "in_progress", "done", "review"]);

interface Transaction {
  label: string;
  commands: Command[];
}

type Field<T> = { kind: "set"; value: T } | { kind: "clear" };

function field<T>(value: T | null): Field<T> {
  return value === null ? { kind: "clear" } : { kind: "set", value };
}

function qualified(value: unknown, name: string): string {
  const text = str(value, name);
  if (!/^[^/\s]{1,200}\/[^/\s]{1,200}$/.test(text))
    throw invalid(`${name} must be a qualified id`);
  return text;
}

function ids(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw invalid(`${name} must be an array`);
  if (value.length > MAX_IDS) throw invalid(`${name} is too long`);
  return strList(value, name);
}

function labelId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return str(value, "labelId");
}

function zOrder(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    Math.abs(value) > 2 ** 31 - 1
  )
    throw invalid("zOrder must be an integer");
  return value;
}

/** 属性の部分更新（指定したキーだけ置き換え、`null` でキーを削除）。 */
function mergeAttributes(current: JsonObject, patch: JsonObject): JsonObject {
  const next: JsonObject = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

function target(value: unknown): {
  assetId: string;
  itemKey: string | undefined;
} {
  const t = obj(value, "target");
  return {
    assetId: str(t.assetId, "assetId"),
    itemKey: optStr(t.itemKey, "itemKey"),
  };
}

export interface WriteApi {
  handlers: Handlers;
  /** 枠・拡張機能が無くなったとき、開いている transaction を捨てる。 */
  abortTransactions(extId: string): void;
  /** 作成の入力を検査してコマンドを作る（書き込まない）。 */
  buildCreate(
    ctx: Ctx,
    raw: unknown,
  ): Promise<{ command: Command; annotation: Record<string, unknown> }>;
}

export function createWriteHandlers(): WriteApi {
  const open = new Map<string, Transaction>();

  /** アイテムの行が無いときに作る行の提供者（既にあれば、使われない）。 */
  function providerFor(ctx: Ctx): string {
    const first = ctx.deps.manifests.get(ctx.extId)?.contributes
      .itemProviders[0];
    return `${ctx.extId}/${first ?? "items"}`;
  }

  function coreTarget(
    ctx: Ctx,
    t: { assetId: string; itemKey: string | undefined },
  ) {
    return {
      asset_id: t.assetId,
      item:
        t.itemKey === undefined
          ? null
          : {
              asset_id: t.assetId,
              item_key: t.itemKey,
              provider: providerFor(ctx),
            },
    };
  }

  /** 書く。transaction の途中なら溜めるだけ。 */
  async function write(
    ctx: Ctx,
    command: Command,
    name: string,
  ): Promise<void> {
    const tx = open.get(ctx.extId);
    if (tx !== undefined) {
      if (tx.commands.length >= MAX_TRANSACTION_COMMANDS)
        throw invalid("transaction is too large");
      tx.commands.push(command);
      return;
    }
    const set = await ctx.ipc.applyCommand(ctx.extId, command);
    ctx.deps.onApplied?.(set, name);
  }

  /** 部分更新のために、現在の値を読む（読み取りの権限を、ここで確かめる）。 */
  async function needRead(ctx: Ctx): Promise<void> {
    await ctx.deps.gate.requirePermission(ctx.extId, "annotations.read");
  }

  async function removeAll(
    ctx: Ctx,
    args: unknown,
    kind: "delete_annotation" | "delete_relation" | "delete_group",
  ): Promise<null> {
    const [list] = positional(args);
    const targets = ids(list, "ids");
    if (targets.length === 0) return null;
    const commands = targets.map((id) => ({ kind, id }) as Command);
    const only = commands[0];
    await write(
      ctx,
      commands.length === 1 && only !== undefined
        ? only
        : { kind: "transaction", commands },
      kind,
    );
    return null;
  }

  /** `annotations.create` の入力を検査して、書き込むコマンドと返す値を作る（`annotations.suggest` と共有）。 */
  async function buildCreate(
    ctx: Ctx,
    raw: unknown,
  ): Promise<{ command: Command; annotation: Record<string, unknown> }> {
    const n = obj(raw, "annotation");
    const t = target(n.target);
    const type = qualified(n.type, "type");
    if (n.selector === undefined) throw invalid("selector is required");
    const selector = n.selector;
    const selectorJson = JSON.stringify(selector);
    if (selectorJson === undefined) throw invalid("selector must be JSON");
    const label = labelId(n.labelId);
    const attributes =
      n.attributes === undefined ? {} : jsonObject(n.attributes, "attributes");
    const z = zOrder(n.zOrder);
    const local = type.startsWith(`${ctx.extId}/`)
      ? type.slice(ctx.extId.length + 1)
      : undefined;
    const version =
      local === undefined
        ? undefined
        : ctx.deps.manifests.get(ctx.extId)?.annotationTypeVersions[local];
    // 書き込みの前に、定義側の枠へ問い合わせる（失敗したら書かない）。
    const summary =
      (
        await ctx.deps.typeChecks?.check({
          type,
          selector,
          assetId: t.assetId,
        })
      )?.summary ?? "";
    const id = uuidv7();
    const command = {
      kind: "create_annotation",
      id,
      target: coreTarget(ctx, t),
      type,
      ...(version === undefined ? {} : { type_version: version }),
      selector_json: selectorJson,
      ...(summary === "" ? {} : { summary }),
      label_id: label ?? null,
      attributes_json: JSON.stringify(attributes),
      ...(z === undefined ? {} : { z_order: z }),
      source: ctx.extId,
    } as Command;
    const now = Date.now();
    return {
      command,
      annotation: {
        id,
        target:
          t.itemKey === undefined
            ? { assetId: t.assetId }
            : { assetId: t.assetId, itemKey: t.itemKey },
        type,
        typeVersion: version ?? 1,
        selector,
        labelId: label ?? null,
        attributes,
        summary,
        zOrder: z ?? 0,
        source: ctx.extId,
        createdAt: now,
        updatedAt: now,
      },
    };
  }

  const handlers: Handlers = {
    "annotations.create": async (ctx, a) => {
      const [raw] = positional(a);
      const { command, annotation } = await buildCreate(ctx, raw);
      await write(ctx, command, "create_annotation");
      return annotation;
    },
    "annotations.update": async (ctx, a) => {
      const [idArg, patchArg] = positional(a);
      const id = str(idArg, "id");
      const p = obj(patchArg, "patch");
      const patch: Record<string, unknown> = {};
      if (p.selector !== undefined) {
        const json = JSON.stringify(p.selector);
        if (json === undefined) throw invalid("selector must be JSON");
        patch.selector_json = { kind: "set", value: json };
        if (ctx.deps.typeChecks !== undefined) {
          // 検査には、既存の種別とアセットが要る（読み取りの権限を確かめる）。
          await needRead(ctx);
          const rows = await ctx.ipc.annotationsQuery(ctx.extId, {
            asset_id: null,
            item_key: null,
            types: [],
            label_ids: [],
            ids: [id],
            limit: 1,
            offset: null,
          });
          const row = rows[0];
          if (row === undefined)
            throw new HostApiError("NotFound", "annotation not found");
          const { summary } = await ctx.deps.typeChecks.check({
            type: row.type,
            selector: p.selector,
            assetId: row.asset_id,
          });
          patch.summary = { kind: "set", value: summary };
        }
      }
      const label = labelId(p.labelId);
      if (label !== undefined) patch.label_id = field(label);
      const z = zOrder(p.zOrder);
      if (z !== undefined) patch.z_order = { kind: "set", value: z };
      if (p.attributes !== undefined) {
        const partial = jsonObject(p.attributes, "attributes");
        await needRead(ctx);
        const rows = await ctx.ipc.annotationsQuery(ctx.extId, {
          asset_id: null,
          item_key: null,
          types: [],
          label_ids: [],
          ids: [id],
          limit: 1,
          offset: null,
        });
        const row = rows[0];
        if (row === undefined)
          throw new HostApiError("NotFound", "annotation not found");
        patch.attributes_json = {
          kind: "set",
          value: JSON.stringify(
            mergeAttributes(parseObject(row.attributes_json), partial),
          ),
        };
      }
      await write(
        ctx,
        { kind: "update_annotation", id, patch } as Command,
        "update_annotation",
      );
      return null;
    },
    "annotations.remove": (ctx, a) => removeAll(ctx, a, "delete_annotation"),
    "annotations.transaction": async (ctx, a) => {
      const op = obj(a, "transaction");
      switch (op.op) {
        case "begin": {
          if (open.has(ctx.extId)) throw invalid("transaction is already open");
          open.set(ctx.extId, { label: str(op.label, "label"), commands: [] });
          return null;
        }
        case "abort":
          open.delete(ctx.extId);
          return null;
        case "commit": {
          const tx = open.get(ctx.extId);
          if (tx === undefined) throw invalid("no open transaction");
          // 失敗しても、成功しても、開きっぱなしにしない。
          open.delete(ctx.extId);
          if (tx.commands.length === 0) return null;
          const set = await ctx.ipc.applyCommand(ctx.extId, {
            kind: "transaction",
            commands: tx.commands,
          } as Command);
          ctx.deps.onApplied?.(set, tx.label);
          return null;
        }
        default:
          throw invalid("unknown transaction op");
      }
    },

    "relations.create": async (ctx, a) => {
      const [raw] = positional(a);
      const r = obj(raw, "relation");
      const type = qualified(r.type, "type");
      const fromId = str(r.fromId, "fromId");
      const toId = str(r.toId, "toId");
      const label = labelId(r.labelId);
      const attributes =
        r.attributes === undefined
          ? {}
          : jsonObject(r.attributes, "attributes");
      const id = uuidv7();
      await write(
        ctx,
        {
          kind: "create_relation",
          id,
          type,
          from_id: fromId,
          to_id: toId,
          label_id: label ?? null,
          attributes_json: JSON.stringify(attributes),
          source: ctx.extId,
        } as Command,
        "create_relation",
      );
      return {
        id,
        type,
        fromId,
        toId,
        directed: true,
        labelId: label ?? null,
        attributes,
        source: ctx.extId,
      };
    },
    "relations.update": async (ctx, a) => {
      const [idArg, patchArg] = positional(a);
      const id = str(idArg, "id");
      const patch = await linkPatch(ctx, patchArg, async () => {
        const rows = await ctx.ipc.relationsQuery(ctx.extId, {
          ids: [id],
          annotation_ids: [],
          asset_id: null,
          types: [],
        });
        return rows[0]?.attributes_json;
      });
      await write(
        ctx,
        { kind: "update_relation", id, patch } as Command,
        "update_relation",
      );
      return null;
    },
    "relations.remove": (ctx, a) => removeAll(ctx, a, "delete_relation"),

    "groups.create": async (ctx, a) => {
      const [raw] = positional(a);
      const g = obj(raw, "group");
      const type = qualified(g.type, "type");
      const members = ids(g.memberIds, "memberIds");
      const label = labelId(g.labelId);
      const attributes =
        g.attributes === undefined
          ? {}
          : jsonObject(g.attributes, "attributes");
      const id = uuidv7();
      await write(
        ctx,
        {
          kind: "create_group",
          id,
          type,
          label_id: label ?? null,
          attributes_json: JSON.stringify(attributes),
          members,
          source: ctx.extId,
        } as Command,
        "create_group",
      );
      return {
        id,
        type,
        ordered: false,
        memberIds: members,
        labelId: label ?? null,
        attributes,
        source: ctx.extId,
      };
    },
    "groups.update": async (ctx, a) => {
      const [idArg, patchArg] = positional(a);
      const id = str(idArg, "id");
      const patch = await linkPatch(ctx, patchArg, async () => {
        const rows = await ctx.ipc.groupsQuery(ctx.extId, {
          ids: [id],
          annotation_ids: [],
          asset_id: null,
          types: [],
        });
        return rows[0]?.attributes_json;
      });
      await write(
        ctx,
        { kind: "update_group", id, patch } as Command,
        "update_group",
      );
      return null;
    },
    "groups.remove": (ctx, a) => removeAll(ctx, a, "delete_group"),
    "groups.setMembers": async (ctx, a) => {
      const [idArg, membersArg] = positional(a);
      const id = str(idArg, "id");
      const wanted = [...new Set(ids(membersArg, "memberIds"))];
      await needRead(ctx);
      const rows = await ctx.ipc.groupsQuery(ctx.extId, {
        ids: [id],
        annotation_ids: [],
        asset_id: null,
        types: [],
      });
      const group = rows[0];
      if (group === undefined)
        throw new HostApiError("NotFound", "group not found");
      const commands = membershipCommands(id, group.member_ids, wanted);
      const first = commands[0];
      if (first === undefined) return null;
      await write(
        ctx,
        commands.length === 1
          ? first
          : ({ kind: "transaction", commands } as Command),
        "set_group_members",
      );
      return null;
    },

    "assets.setMetadata": async (ctx, a) => {
      const [idArg, metadataArg, itemKeyArg] = positional(a);
      const assetId = str(idArg, "id");
      const metadata = jsonObject(metadataArg, "metadata");
      const itemKey = optStr(itemKeyArg, "itemKey");
      const metadataJson = JSON.stringify(metadata);
      const command =
        itemKey === undefined
          ? {
              kind: "set_asset_metadata",
              asset_id: assetId,
              namespace: ctx.extId,
              metadata_json: metadataJson,
            }
          : {
              kind: "set_item_metadata",
              item: {
                asset_id: assetId,
                item_key: itemKey,
                provider: providerFor(ctx),
              },
              namespace: ctx.extId,
              metadata_json: metadataJson,
            };
      await write(ctx, command as Command, "set_metadata");
      return null;
    },
    "assets.setStatus": async (ctx, a) => {
      const [targetArg, statusArg] = positional(a);
      const t = target(targetArg);
      if (typeof statusArg !== "string" || !STATUSES.has(statusArg))
        throw invalid("status is invalid");
      const command =
        t.itemKey === undefined
          ? { kind: "set_asset_status", asset_id: t.assetId, status: statusArg }
          : {
              kind: "set_item_status",
              item: {
                asset_id: t.assetId,
                item_key: t.itemKey,
                provider: providerFor(ctx),
              },
              status: statusArg,
            };
      await write(ctx, command as Command, "set_status");
      return null;
    },
  };

  /** 関係・グループの更新のパッチ（`labelId`・`attributes` の部分更新）。 */
  async function linkPatch(
    ctx: Ctx,
    raw: unknown,
    currentAttributes: () => Promise<string | undefined>,
  ): Promise<Record<string, unknown>> {
    const p = optObj(raw, "patch") ?? {};
    const patch: Record<string, unknown> = {};
    const label = labelId(p.labelId);
    if (label !== undefined) patch.label_id = field(label);
    if (p.attributes !== undefined) {
      const partial = jsonObject(p.attributes, "attributes");
      await needRead(ctx);
      const current = await currentAttributes();
      if (current === undefined)
        throw new HostApiError("NotFound", "not found");
      patch.attributes_json = {
        kind: "set",
        value: JSON.stringify(mergeAttributes(parseObject(current), partial)),
      };
    }
    return patch;
  }

  return {
    handlers,
    abortTransactions: (extId) => void open.delete(extId),
    buildCreate,
  };
}

/** 現在のメンバーを、望みの並びにするためのコマンド（外す → 足す / 動かす）。 */
export function membershipCommands(
  groupId: string,
  current: string[],
  wanted: string[],
): Command[] {
  const commands: Command[] = [];
  const removed = current.filter((m) => !wanted.includes(m));
  if (removed.length > 0)
    commands.push({
      kind: "remove_group_members",
      group_id: groupId,
      annotation_ids: removed,
    } as Command);
  const working = current.filter((m) => wanted.includes(m));
  wanted.forEach((member, index) => {
    if (working[index] === member) return;
    const at = working.indexOf(member);
    if (at === -1) {
      commands.push({
        kind: "add_group_members",
        group_id: groupId,
        annotation_ids: [member],
        at: index,
      } as Command);
      working.splice(index, 0, member);
    } else {
      commands.push({
        kind: "move_group_member",
        group_id: groupId,
        annotation_id: member,
        to_position: index,
      } as Command);
      working.splice(at, 1);
      working.splice(index, 0, member);
    }
  });
  return commands;
}
