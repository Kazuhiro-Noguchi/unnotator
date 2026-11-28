// 読み取りの Host API（`assets`・`annotations.query`・`relations.query`・`groups.query`・`labels`）。
// 先に権限の門（api.ts）を通った呼び出しだけが、ここに来る。
import type { Ctx, Handlers } from "./api-types";
import {
  invalid,
  type JsonObject,
  optInt,
  optObj,
  optStr,
  parseObject,
  positional,
  str,
  strList,
} from "./convert";
import {
  type AppliesTo,
  toAnnotation,
  toAsset,
  toGroup,
  toItem,
  toLabel,
  toRelation,
} from "./mappers";
import { HostApiError } from "./permissions";

/** `assets.read` の 1 回の呼び出しで返す合計の大きさの上限。 */
export const MAX_READ_BYTES = 64 * 1024 * 1024;

async function readAsset(
  ctx: Ctx,
  assetId: string,
  offset: number,
  length: number | undefined,
): Promise<Uint8Array> {
  if (length !== undefined && length > MAX_READ_BYTES)
    throw invalid("read range is too large");
  const chunks: number[][] = [];
  let total = 0;
  let position = offset;
  while (length === undefined || total < length) {
    const want = length === undefined ? null : length - total;
    const chunk = await ctx.ipc.assetRead(ctx.extId, assetId, position, want);
    if (chunk.length === 0) break;
    chunks.push(chunk);
    total += chunk.length;
    position += chunk.length;
    if (total > MAX_READ_BYTES) throw invalid("read range is too large");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function range(v: unknown): { offset: number; length: number | undefined } {
  const r = optObj(v, "range");
  return {
    offset: optInt(r?.offset, "range.offset") ?? 0,
    length: optInt(r?.length, "range.length"),
  };
}

function annotationFilter(v: unknown) {
  const q = optObj(v, "query") ?? {};
  return {
    asset_id: optStr(q.assetId, "assetId") ?? null,
    item_key: optStr(q.itemKey, "itemKey") ?? null,
    types: strList(q.types, "types"),
    label_ids: strList(q.labelIds, "labelIds"),
    ids: strList(q.ids, "ids"),
    limit: optInt(q.limit, "limit") ?? null,
    offset: optInt(q.offset, "offset") ?? null,
  };
}

function linkFilter(v: unknown) {
  const q = optObj(v, "query") ?? {};
  return {
    annotation_ids: strList(q.annotationIds, "annotationIds"),
    asset_id: optStr(q.assetId, "assetId") ?? null,
    types: strList(q.types, "types"),
  };
}

function appliesToMatches(
  applies: AppliesTo,
  key: "annotationTypes" | "relationTypes" | "groupTypes" | "mediaTypes",
  value: string,
): boolean {
  const list = applies[key];
  return list === undefined || list.length === 0 || list.includes(value);
}

function unrestricted(applies: AppliesTo): boolean {
  return (
    Object.keys(applies).filter(
      (k) => k !== "classification" && (applies as Record<string, unknown>)[k],
    ).length === 0 && applies.classification === undefined
  );
}

function labelPasses(
  applies: AppliesTo,
  hidden: boolean,
  f: Record<string, unknown>,
): boolean {
  if (hidden && f.includeHidden !== true) return false;
  const checks: [
    "annotationTypes" | "relationTypes" | "groupTypes" | "mediaTypes",
    unknown,
  ][] = [
    ["annotationTypes", f.annotationType],
    ["relationTypes", f.relationType],
    ["groupTypes", f.groupType],
    ["mediaTypes", f.mediaType],
  ];
  for (const [key, value] of checks) {
    if (typeof value === "string" && !appliesToMatches(applies, key, value))
      return false;
  }
  if (f.classification === true)
    return applies.classification === true || unrestricted(applies);
  return true;
}

function mergeSchemas(parts: JsonObject[]): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const part of parts) {
    const props = part.properties;
    if (typeof props === "object" && props !== null && !Array.isArray(props))
      Object.assign(properties, props);
    const req = part.required;
    if (Array.isArray(req)) {
      for (const name of req)
        if (typeof name === "string" && !required.includes(name))
          required.push(name);
    }
  }
  const merged: JsonObject = { type: "object", properties };
  if (required.length > 0) merged.required = required;
  return merged;
}

export const readHandlers: Handlers = {
  "assets.get": async (ctx, a) => {
    const [id] = positional(a);
    const row = await ctx.ipc.assetGet(ctx.extId, str(id, "id"));
    if (row === null) throw new HostApiError("NotFound", "asset not found");
    return toAsset(row);
  },
  "assets.getItem": async (ctx, a) => {
    const [assetId, itemKey] = positional(a);
    const row = await ctx.ipc.itemGet(
      ctx.extId,
      str(assetId, "assetId"),
      str(itemKey, "itemKey"),
    );
    return row === null ? null : toItem(row);
  },
  "assets.read": async (ctx, a) => {
    const [id, r] = positional(a);
    const { offset, length } = range(r);
    const bytes = await readAsset(ctx, str(id, "id"), offset, length);
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  },
  "assets.readText": async (ctx, a) => {
    const [id, encoding] = positional(a);
    const label = optStr(encoding, "encoding") ?? "utf-8";
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(label);
    } catch {
      throw invalid(`unknown encoding: ${label}`);
    }
    return decoder.decode(await readAsset(ctx, str(id, "id"), 0, undefined));
  },
  "annotations.query": async (ctx, a) => {
    const [q] = positional(a);
    const rows = await ctx.ipc.annotationsQuery(ctx.extId, annotationFilter(q));
    return rows.map(toAnnotation);
  },
  "relations.query": async (ctx, a) => {
    const [q] = positional(a);
    const rows = await ctx.ipc.relationsQuery(ctx.extId, linkFilter(q));
    return rows.map(toRelation);
  },
  "groups.query": async (ctx, a) => {
    const [q] = positional(a);
    const rows = await ctx.ipc.groupsQuery(ctx.extId, linkFilter(q));
    return rows.map(toGroup);
  },
  "labels.list": async (ctx, a) => {
    const [filter] = positional(a);
    const f = optObj(filter, "filter") ?? {};
    const rows = await ctx.ipc.labelsList(ctx.extId);
    return rows
      .map((row) => toLabel(row, ctx.deps.locale()))
      .filter((label) => labelPasses(label.appliesTo, label.hidden, f));
  },
  "labels.attributeSchema": async (ctx, a) => {
    const [opts] = positional(a);
    const o = optObj(opts, "options") ?? {};
    const labelId = optStr(o.labelId, "labelId");
    const annotationType = optStr(o.annotationType, "annotationType");
    const rows = await ctx.ipc.schemasList(ctx.extId);
    const find = (scope: string, target: string): JsonObject =>
      parseObject(
        rows.find((r) => r.scope === scope && r.target === target)
          ?.schema_json ?? "{}",
      );
    const parts = [find("global", "")];
    if (annotationType !== undefined)
      parts.push(find("annotation_type", annotationType));
    if (labelId !== undefined) parts.push(find("label", labelId));
    return mergeSchemas(parts);
  },
};
