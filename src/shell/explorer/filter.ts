// フィルター条件の操作（純関数）。形は specs/007-tree-preview/data-model.md の `TreeFilter`。
import type { Status } from "../../ipc";
import type { MediaSel, TreeFilter } from "./types";

export const EMPTY_FILTER: TreeFilter = {
  name: null,
  statuses: [],
  media_types: [],
  missing: null,
};

function sameMedia(a: MediaSel, b: MediaSel): boolean {
  if (a.kind === "unknown") return b.kind === "unknown";
  return b.kind === "is" && a.value === b.value;
}

/** 空白を除き、重複を除く。空の名前は条件なし（`null`）。 */
export function normalizeFilter(input: Partial<TreeFilter>): TreeFilter {
  const name = input.name?.trim() ?? "";
  const media: MediaSel[] = [];
  for (const sel of input.media_types ?? []) {
    if (!media.some((m) => sameMedia(m, sel))) media.push(sel);
  }
  return {
    name: name === "" ? null : name,
    statuses: [...new Set(input.statuses ?? [])],
    media_types: media,
    missing: input.missing ?? null,
  };
}

export function isEmptyFilter(filter: TreeFilter): boolean {
  const f = normalizeFilter(filter);
  return (
    f.name === null &&
    f.statuses.length === 0 &&
    f.media_types.length === 0 &&
    f.missing === null
  );
}

export function setName(filter: TreeFilter, name: string): TreeFilter {
  return normalizeFilter({ ...filter, name });
}

export function toggleStatus(filter: TreeFilter, status: Status): TreeFilter {
  const has = filter.statuses.includes(status);
  return normalizeFilter({
    ...filter,
    statuses: has
      ? filter.statuses.filter((s) => s !== status)
      : [...filter.statuses, status],
  });
}

export function toggleMedia(filter: TreeFilter, sel: MediaSel): TreeFilter {
  const has = filter.media_types.some((m) => sameMedia(m, sel));
  return normalizeFilter({
    ...filter,
    media_types: has
      ? filter.media_types.filter((m) => !sameMedia(m, sel))
      : [...filter.media_types, sel],
  });
}

export function setMissing(
  filter: TreeFilter,
  missing: boolean | null,
): TreeFilter {
  return normalizeFilter({ ...filter, missing });
}

export function clearFilter(): TreeFilter {
  return { ...EMPTY_FILTER, statuses: [], media_types: [] };
}
