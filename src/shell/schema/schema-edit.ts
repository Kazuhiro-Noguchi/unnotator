// 属性スキーマの編集用の形。JSON Schema のサブセット（002）と、画面で編集する項目の往復。純関数。
import type { FieldKind } from "./derive-form";

export interface EditorProperty {
  name: string;
  kind: FieldKind;
  title: string;
  description: string;
  required: boolean;
  /** 既定値の入力（文字）。空なら既定値なし。 */
  defaultText: string;
  /** 選択肢（`kind` が `enum` のとき）。 */
  options: string[];
}

export function blankProperty(): EditorProperty {
  return {
    name: "",
    kind: "string",
    title: "",
    description: "",
    required: false,
    defaultText: "",
    options: [],
  };
}

interface RawProperty {
  type?: unknown;
  enum?: unknown;
  default?: unknown;
  title?: unknown;
  description?: unknown;
}

export function fromSchemaJson(json: string | null): EditorProperty[] {
  if (json === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const { properties, required } = parsed as {
    properties?: Record<string, RawProperty>;
    required?: unknown;
  };
  const requiredNames = Array.isArray(required) ? required : [];
  return Object.entries(properties ?? {}).flatMap(([name, p]) => {
    const kind: FieldKind | null =
      Array.isArray(p.enum) && p.enum.length > 0
        ? "enum"
        : p.type === "string" ||
            p.type === "number" ||
            p.type === "integer" ||
            p.type === "boolean"
          ? p.type
          : null;
    if (kind === null) return [];
    return [
      {
        name,
        kind,
        title: typeof p.title === "string" ? p.title : "",
        description: typeof p.description === "string" ? p.description : "",
        required: requiredNames.includes(name),
        defaultText: p.default === undefined ? "" : String(p.default),
        options:
          kind === "enum" && Array.isArray(p.enum) ? p.enum.map(String) : [],
      },
    ];
  });
}

function defaultValue(property: EditorProperty): unknown {
  const text = property.defaultText;
  switch (property.kind) {
    case "number":
    case "integer":
      return Number(text);
    case "boolean":
      return text === "true";
    default:
      return text;
  }
}

export function toSchemaJson(items: readonly EditorProperty[]): string {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const item of items) {
    const out: Record<string, unknown> =
      item.kind === "enum" ? { enum: item.options } : { type: item.kind };
    if (item.title !== "") out.title = item.title;
    if (item.description !== "") out.description = item.description;
    if (item.defaultText !== "") out.default = defaultValue(item);
    properties[item.name.trim()] = out;
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  const required = items.filter((i) => i.required).map((i) => i.name.trim());
  if (required.length > 0) schema.required = required;
  return JSON.stringify(schema);
}

export type PropertyErrorCode = "name" | "duplicate" | "options" | "default";

export interface PropertyError {
  index: number;
  code: PropertyErrorCode;
}

export function validateProperties(
  items: readonly EditorProperty[],
): PropertyError[] {
  const errors: PropertyError[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const name = item.name.trim();
    if (name === "") errors.push({ index, code: "name" });
    else if (seen.has(name)) errors.push({ index, code: "duplicate" });
    seen.add(name);
    if (item.kind === "enum") {
      const unique = new Set(item.options);
      if (item.options.length === 0 || unique.size !== item.options.length) {
        errors.push({ index, code: "options" });
        return;
      }
    }
    if (item.defaultText !== "" && !defaultFits(item)) {
      errors.push({ index, code: "default" });
    }
  });
  return errors;
}

function defaultFits(item: EditorProperty): boolean {
  const text = item.defaultText;
  switch (item.kind) {
    case "number":
      return Number.isFinite(Number(text));
    case "integer":
      return Number.isInteger(Number(text));
    case "boolean":
      return text === "true" || text === "false";
    case "enum":
      return item.options.includes(text);
    default:
      return true;
  }
}
