// 属性値（`attributes_json`）の読み書きの小さな純関数。スキーマに無いキーは、そのまま残す。

export type Attributes = Record<string, unknown>;

export function parseAttributes(json: string): Attributes {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Attributes)
      : {};
  } catch {
    return {};
  }
}

/** `value` が `undefined` なら、キーを消す。 */
export function withValue(
  attributes: Attributes,
  name: string,
  value: unknown,
): Attributes {
  const next = { ...attributes };
  if (value === undefined) delete next[name];
  else next[name] = value;
  return next;
}
