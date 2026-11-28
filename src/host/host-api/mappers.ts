// Rust の行（`*_json` は文字列）→ 拡張機能が受け取る型（`plugin-api`）。
import { type Json, type JsonObject, parseJson, parseObject } from "./convert";
import type {
  AnnotationDto,
  AssetDto,
  GroupDto,
  ItemDto,
  LabelDto,
  RelationDto,
} from "./ipc";

export function toAsset(row: AssetDto) {
  const namespaced = parseObject(row.metadata_json);
  const metadata: Record<string, JsonObject> = {};
  for (const [ext, value] of Object.entries(namespaced)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value))
      metadata[ext] = value as JsonObject;
  }
  return {
    id: row.id,
    rootKey: row.root_key,
    relPath: row.rel_path,
    mediaType: row.media_type,
    fileSize: row.file_size ?? 0,
    mtimeMs: row.mtime_ms ?? 0,
    status: row.status,
    missing: row.missing,
    metadata,
    attributes: parseObject(row.attributes_json),
  };
}

export function toItem(row: ItemDto) {
  return {
    id: row.id,
    assetId: row.asset_id,
    key: row.item_key,
    provider: row.provider,
    status: row.status,
    metadata: parseObject(row.metadata_json),
    attributes: parseObject(row.attributes_json),
  };
}

export function toAnnotation(row: AnnotationDto) {
  return {
    id: row.id,
    target:
      row.item_key === null
        ? { assetId: row.asset_id }
        : { assetId: row.asset_id, itemKey: row.item_key },
    type: row.type,
    typeVersion: row.type_version,
    selector: parseJson(row.selector_json) as Json,
    labelId: row.label_id,
    attributes: parseObject(row.attributes_json),
    summary: row.summary,
    zOrder: row.z_order,
    source: row.source,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0,
  };
}

export function toRelation(row: RelationDto) {
  return {
    id: row.id,
    type: row.type,
    fromId: row.from_id,
    toId: row.to_id,
    directed: row.directed,
    labelId: row.label_id,
    attributes: parseObject(row.attributes_json),
    source: row.source,
  };
}

export function toGroup(row: GroupDto) {
  return {
    id: row.id,
    type: row.type,
    ordered: row.ordered,
    memberIds: row.member_ids,
    labelId: row.label_id,
    attributes: parseObject(row.attributes_json),
    source: row.source,
  };
}

export interface AppliesTo {
  annotationTypes?: string[];
  relationTypes?: string[];
  groupTypes?: string[];
  mediaTypes?: string[];
  classification?: boolean;
}

export function toLabel(row: LabelDto, language: string) {
  const names = parseObject(row.name_i18n_json);
  const localized = names[language];
  const raw = parseObject(row.applies_to_json);
  const appliesTo: AppliesTo = {};
  for (const key of [
    "annotationTypes",
    "relationTypes",
    "groupTypes",
    "mediaTypes",
  ] as const) {
    const list = raw[key];
    if (Array.isArray(list) && list.every((x) => typeof x === "string"))
      appliesTo[key] = list as string[];
  }
  if (typeof raw.classification === "boolean")
    appliesTo.classification = raw.classification;
  return {
    id: row.id,
    name: row.name,
    displayName:
      typeof localized === "string" && localized !== "" ? localized : row.name,
    color: row.color,
    hotkey: row.hotkey,
    hidden: row.hidden,
    appliesTo,
  };
}
