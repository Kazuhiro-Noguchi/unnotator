// 属性スキーマから、属性フォームを導く。純関数（specs/008-properties-labels/data-model.md の「フォーム導出の規則」）。
//
// スキーマは JSON Schema のサブセット（002）: type=object、properties の各型は string / number / integer / boolean / enum、
// required、default、title、description。値の検証はコアではなく、ここ（画面側）で行う（research R5）。
import type { SchemaRow } from "../project-data/types";

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum";
export type FieldError = "required" | "number" | "integer" | "enum";

export interface FormField {
  name: string;
  title: string;
  description?: string;
  kind: FieldKind;
  required: boolean;
  defaultValue?: unknown;
  options?: string[];
}

export type FormTarget =
  | { kind: "annotation"; type: string; labelId: string | null }
  | { kind: "relation"; type: string; labelId: string | null }
  | { kind: "group"; type: string; labelId: string | null }
  | { kind: "asset"; mediaType: string | null }
  | { kind: "item"; provider: string | null };

/** 対象に当てはまるスキーマを、全体 → 種別 → ラベル（アセット・アイテムは、すべて → 媒体種別・提供元）の順に返す。 */
export function schemasFor(
  rows: readonly SchemaRow[],
  target: FormTarget,
): SchemaRow[] {
  const pick = (scope: string, key: string | null) =>
    key === null
      ? []
      : rows.filter((r) => r.scope === scope && r.target === key);
  switch (target.kind) {
    case "annotation":
    case "relation":
    case "group": {
      const typeScope = `${target.kind}_type`;
      return [
        ...pick("global", ""),
        ...pick(typeScope, target.type),
        ...pick("label", target.labelId),
      ];
    }
    case "asset":
      return [...pick("asset", ""), ...pick("asset", target.mediaType)];
    case "item":
      return [...pick("item", ""), ...pick("item", target.provider)];
  }
}

interface RawProperty {
  type?: unknown;
  enum?: unknown;
  default?: unknown;
  title?: unknown;
  description?: unknown;
}

function parseSchema(
  row: SchemaRow,
): { properties: Record<string, RawProperty>; required: string[] } | null {
  try {
    const parsed: unknown = JSON.parse(row.schema_json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { properties, required } = parsed as {
      properties?: unknown;
      required?: unknown;
    };
    return {
      properties:
        typeof properties === "object" && properties !== null
          ? (properties as Record<string, RawProperty>)
          : {},
      required: Array.isArray(required)
        ? required.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function kindOf(property: RawProperty): FieldKind | null {
  if (Array.isArray(property.enum) && property.enum.length > 0) return "enum";
  const type = property.type;
  return type === "string" ||
    type === "number" ||
    type === "integer" ||
    type === "boolean"
    ? type
    : null;
}

/** フォームの項目。同名は後ろ（具体的なスキーマ）が優先。並びは最初に現れた順。 */
export function deriveForm(
  rows: readonly SchemaRow[],
  target: FormTarget,
): FormField[] {
  const fields = new Map<string, FormField>();
  for (const row of schemasFor(rows, target)) {
    const schema = parseSchema(row);
    if (schema === null) continue;
    for (const [name, property] of Object.entries(schema.properties)) {
      const kind = kindOf(property);
      if (kind === null) continue;
      const field: FormField = {
        name,
        title: typeof property.title === "string" ? property.title : name,
        kind,
        required: schema.required.includes(name),
      };
      if (typeof property.description === "string") {
        field.description = property.description;
      }
      if (property.default !== undefined) field.defaultValue = property.default;
      if (kind === "enum" && Array.isArray(property.enum)) {
        field.options = property.enum.map(String);
      }
      fields.set(name, field);
    }
  }
  return [...fields.values()];
}

const isEmpty = (value: unknown) => value === undefined || value === "";

/** 値の検証。保存してよい値なら `null`。 */
export function validateField(
  field: FormField,
  value: unknown,
): FieldError | null {
  if (isEmpty(value)) return field.required ? "required" : null;
  return typeError(field, value);
}

function typeError(field: FormField, value: unknown): FieldError | null {
  switch (field.kind) {
    case "string":
    case "boolean":
      return null;
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : "integer";
    case "enum":
      return typeof value === "string" && field.options?.includes(value)
        ? null
        : "enum";
  }
}

/** 保存済みの値が、いまの型に合わない（値は残し、欄に警告を出す）。未設定は合わないとは言わない。 */
export function mismatch(field: FormField, stored: unknown): boolean {
  return !isEmpty(stored) && typeError(field, stored) !== null;
}

/** 入力の文字を、型に直す。空は「未設定」（`undefined`）。 */
export function parseValue(
  field: FormField,
  text: string,
): { ok: true; value: unknown } | { ok: false; error: FieldError } {
  if (text === "") return { ok: true, value: undefined };
  if (field.kind === "number" || field.kind === "integer") {
    const value = Number(text);
    const error = typeError(field, Number.isNaN(value) ? Number.NaN : value);
    return error === null
      ? { ok: true, value }
      : { ok: false, error: field.kind === "integer" ? "integer" : "number" };
  }
  return { ok: true, value: text };
}

export interface FieldIssue {
  error?: FieldError;
  mismatch?: true;
}

/** 欄ごとの問題。既定値は、未設定の欄の値として扱う。問題のない欄は含まない。 */
export function fieldIssues(
  fields: readonly FormField[],
  attributes: Record<string, unknown>,
): Record<string, FieldIssue> {
  const issues: Record<string, FieldIssue> = {};
  for (const field of fields) {
    const stored = attributes[field.name];
    if (mismatch(field, stored)) {
      issues[field.name] = { mismatch: true };
      continue;
    }
    const value = isEmpty(stored) ? field.defaultValue : stored;
    const error = validateField(field, value);
    if (error !== null) issues[field.name] = { error };
  }
  return issues;
}
