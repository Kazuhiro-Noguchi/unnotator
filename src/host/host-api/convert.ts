// 枠から来た引数の検査と、Rust の行 ↔ 拡張機能の型（`plugin-api`）の変換。
// 枠は信頼しないので、引数は必ずここで形を確かめる（`ValidationFailed`）。
import { HostApiError } from "./permissions";

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export function invalid(message: string): HostApiError {
  return new HostApiError("ValidationFailed", message);
}

/** 位置引数の配列。 */
export function positional(a: unknown): unknown[] {
  if (!Array.isArray(a)) throw invalid("arguments must be an array");
  return a;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw invalid(`${name} must be a string`);
  return v;
}

export function optStr(v: unknown, name: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, name);
}

export function strList(v: unknown, name: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw invalid(`${name} must be a string array`);
  return v as string[];
}

export function optInt(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
    throw invalid(`${name} must be a non-negative integer`);
  return v;
}

export function obj(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw invalid(`${name} must be an object`);
  return v;
}

export function optObj(
  v: unknown,
  name: string,
): Record<string, unknown> | undefined {
  return v === undefined || v === null ? undefined : obj(v, name);
}

/** JSON オブジェクト（`attributes` など）。値は JSON で表せるものだけ。 */
export function jsonObject(v: unknown, name: string): JsonObject {
  const o = obj(v, name);
  try {
    JSON.stringify(o);
  } catch {
    throw invalid(`${name} must be JSON`);
  }
  return o as JsonObject;
}

/** DB の JSON 文字列を読む。壊れていれば空のオブジェクト。 */
export function parseObject(text: string): JsonObject {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? (v as JsonObject) : {};
  } catch {
    return {};
  }
}

export function parseJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

/** UUID v7（先頭 48 ビットがミリ秒の時刻）。ID は、書き込みの呼び出し側（ホスト）が決める。 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let t = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
