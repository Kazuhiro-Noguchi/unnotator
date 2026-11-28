// Host API が使う Rust の IPC の出入口（`ext_*`）。テストでは差し替える。
// 拡張機能 ID（`extId`）は、本体が枠の経路から決めて付ける。Rust 側が最終の門で、権限と `source` を固定する。
import { type Command, commands } from "../../ipc";
import type { PermissionVerdict } from "./permissions";

export type WorkStatusDto = "todo" | "in_progress" | "done" | "review";

export interface AssetDto {
  id: string;
  root_key: string;
  rel_path: string;
  media_type: string | null;
  file_size: number | null;
  mtime_ms: number | null;
  status: WorkStatusDto;
  missing: boolean;
  metadata_json: string;
  attributes_json: string;
}

export interface ItemDto {
  id: string;
  asset_id: string;
  item_key: string;
  provider: string;
  status: WorkStatusDto;
  metadata_json: string;
  attributes_json: string;
}

export interface AnnotationDto {
  id: string;
  asset_id: string;
  item_key: string | null;
  type: string;
  type_version: number;
  selector_json: string;
  label_id: string | null;
  attributes_json: string;
  summary: string;
  z_order: number;
  source: string;
  created_at: number | null;
  updated_at: number | null;
}

export interface AnnotationFilterDto {
  asset_id: string | null;
  item_key: string | null;
  types: string[];
  label_ids: string[];
  ids: string[];
  limit: number | null;
  offset: number | null;
}

export interface RelationDto {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  directed: boolean;
  label_id: string | null;
  attributes_json: string;
  source: string;
}

export interface RelationFilterDto {
  annotation_ids: string[];
  asset_id: string | null;
  types: string[];
}

export interface GroupDto {
  id: string;
  type: string;
  ordered: boolean;
  label_id: string | null;
  attributes_json: string;
  source: string;
  member_ids: string[];
}

export interface GroupFilterDto {
  annotation_ids: string[];
  asset_id: string | null;
  types: string[];
}

export interface LabelDto {
  id: string;
  name: string;
  name_i18n_json: string;
  color: string;
  hotkey: number | null;
  sort_order: number;
  hidden: boolean;
  applies_to_json: string;
}

export interface SchemaDto {
  scope: string;
  target: string;
  schema_json: string;
}

/** `apply_command` が返す変更の差分（`ChangeSet`）のうち、使う部分。 */
export interface ChangeSetDto {
  seq: number;
  origin: string;
  changes: { entity: string; id: string; kind: string }[];
  asset_ids: string[];
}

export interface HostIpc {
  checkPermission(
    extId: string,
    permission: string,
  ): Promise<PermissionVerdict>;
  consent(extId: string, permissions: string[]): Promise<void>;
  assetGet(extId: string, assetId: string): Promise<AssetDto | null>;
  itemGet(
    extId: string,
    assetId: string,
    itemKey: string,
  ): Promise<ItemDto | null>;
  /** 範囲を読む。1 回の応答の大きさには、Rust 側の上限がある（続きは `offset` を進めて呼ぶ）。 */
  assetRead(
    extId: string,
    assetId: string,
    offset: number,
    length: number | null,
  ): Promise<number[]>;
  annotationsQuery(
    extId: string,
    filter: AnnotationFilterDto,
  ): Promise<AnnotationDto[]>;
  relationsQuery(
    extId: string,
    filter: RelationFilterDto,
  ): Promise<RelationDto[]>;
  groupsQuery(extId: string, filter: GroupFilterDto): Promise<GroupDto[]>;
  labelsList(extId: string): Promise<LabelDto[]>;
  schemasList(extId: string): Promise<SchemaDto[]>;
  /** 書き込みは `ext_apply_command` だけ。`source` は Rust 側で拡張機能 ID に固定される。 */
  applyCommand(extId: string, command: Command): Promise<ChangeSetDto>;
  storageGet(
    extId: string,
    scope: StorageScopeDto,
    key: string,
  ): Promise<string | null>;
  storageSet(
    extId: string,
    scope: StorageScopeDto,
    key: string,
    valueJson: string,
  ): Promise<void>;
  projectFileRead(extId: string, relPath: string): Promise<number[] | null>;
  projectFileWrite(
    extId: string,
    relPath: string,
    data: number[],
  ): Promise<void>;
  log(extId: string, level: string, message: string): Promise<void>;
}

export interface StorageScopeDto {
  kind: "project" | "asset" | "item";
  id: string;
}

export const realHostIpc: HostIpc = {
  checkPermission: (extId, permission) =>
    commands.extensionCheckPermission(extId, permission),
  consent: async (extId, permissions) => {
    await commands.extensionConsent(extId, permissions);
  },
  assetGet: (extId, assetId) => commands.extAssetGet(extId, assetId),
  itemGet: (extId, assetId, itemKey) =>
    commands.extItemGet(extId, assetId, itemKey),
  assetRead: (extId, assetId, offset, length) =>
    commands.extAssetRead(extId, assetId, offset, length),
  annotationsQuery: (extId, filter) =>
    commands.extAnnotationsQuery(extId, filter),
  relationsQuery: (extId, filter) => commands.extRelationsQuery(extId, filter),
  groupsQuery: (extId, filter) => commands.extGroupsQuery(extId, filter),
  labelsList: (extId) => commands.extLabelsList(extId),
  schemasList: (extId) => commands.extSchemasList(extId),
  applyCommand: (extId, command) => commands.extApplyCommand(extId, command),
  // 次の 3 つの IPC は、書き込み・保存領域の実装（T041・T047）で足す。
  storageGet: unavailable("storage"),
  storageSet: unavailable("storage"),
  projectFileRead: unavailable("projectFiles"),
  projectFileWrite: unavailable("projectFiles"),
  log: unavailable("log"),
};

function unavailable(name: string): () => Promise<never> {
  return () =>
    Promise.reject({ code: "internal", message: `${name} is not wired` });
}
