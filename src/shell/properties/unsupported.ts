// 未対応の種別（担当の拡張機能が無い種別）の判定。データは消さず、ラベル・属性・削除だけを許す（憲章 IV）。
import type { AnnotationRow } from "../project-data/types";

/** コアが持つ種別（`core/classification` など）か、担当の拡張機能がある種別なら対応している。 */
export function isSupportedType(
  type: string,
  supported: ReadonlySet<string>,
): boolean {
  return type.startsWith("core/") || supported.has(type);
}

export function splitAnnotations(
  rows: readonly AnnotationRow[],
  supported: ReadonlySet<string>,
): { supported: AnnotationRow[]; unsupported: AnnotationRow[] } {
  const result = {
    supported: [] as AnnotationRow[],
    unsupported: [] as AnnotationRow[],
  };
  for (const row of rows) {
    (isSupportedType(row.type, supported)
      ? result.supported
      : result.unsupported
    ).push(row);
  }
  return result;
}
