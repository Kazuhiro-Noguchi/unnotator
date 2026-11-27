// テキストの先頭 10MB を、`unno://asset/` から範囲指定で読む（specs/007-tree-preview/research.md R7）。
// 応答は 1 回 4 MiB まで（004・005 の上限）なので、4 MiB ずつ最大 3 回。
// UTF-8 の検査は厳密（`fatal`）で、不正なら一部だけを見せずに「UTF-8 ではない」とする。
// 10MB で切るときの、文字の途中の切れ端は捨てる。

export const MAX_TEXT_BYTES = 10 * 1024 * 1024;
export const CHUNK_BYTES = 4 * 1024 * 1024;

export type TextLoadReason = "not-utf8" | "read-failed";

export class TextLoadError extends Error {
  readonly reason: TextLoadReason;
  constructor(reason: TextLoadReason, message?: string) {
    super(message ?? reason);
    this.name = "TextLoadError";
    this.reason = reason;
  }
}

export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export interface LoadTextOptions {
  url: string;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  maxBytes?: number;
  chunkBytes?: number;
}

export interface LoadedText {
  text: string;
  /** 先頭の `maxBytes` だけを読んだ（続きがある）。 */
  truncated: boolean;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** `Content-Range: bytes a-b/total` の total。 */
function totalOf(response: Response): number | null {
  const match = /\/(\d+)\s*$/.exec(response.headers.get("Content-Range") ?? "");
  return match?.[1] === undefined ? null : Number(match[1]);
}

export async function loadTextHead(
  options: LoadTextOptions,
): Promise<LoadedText> {
  const max = options.maxBytes ?? MAX_TEXT_BYTES;
  const chunk = options.chunkBytes ?? CHUNK_BYTES;
  const fetchFn: FetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let offset = 0;
  let total: number | null = null;

  const push = (bytes: Uint8Array) => {
    try {
      parts.push(utf8.decode(bytes, { stream: true }));
    } catch {
      throw new TextLoadError("not-utf8");
    }
  };

  while (offset < max) {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const end = Math.min(offset + chunk, max) - 1;
    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await fetchFn(options.url, {
        headers: { Range: `bytes=${offset}-${end}` },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (response.status === 416) break; // 空のファイル
      if (!response.ok)
        throw new TextLoadError("read-failed", `HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof TextLoadError) throw error;
      if (isAbort(error)) throw error;
      throw new TextLoadError("read-failed", String(error));
    }
    if (response.status === 200) {
      // Range を無視して全体を返したとき。先頭の `max` だけを使って終わる。
      total = bytes.length;
      push(bytes.subarray(0, max));
      offset = Math.min(bytes.length, max);
      break;
    }
    total = totalOf(response) ?? total;
    if (bytes.length === 0) break;
    push(bytes);
    offset += bytes.length;
    if (total !== null && offset >= total) break;
  }

  const truncated = total !== null ? total > max : offset >= max;
  if (!truncated) {
    // 終わりの不完全な文字は、不正として扱う。
    try {
      parts.push(utf8.decode());
    } catch {
      throw new TextLoadError("not-utf8");
    }
  }
  return { text: parts.join(""), truncated };
}

/** 行の位置の索引。行ごとの文字列は作らず、見える行だけを切り出す。 */
export interface LineIndex {
  readonly count: number;
  line(index: number): string;
}

export function buildLineIndex(text: string): LineIndex {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10) count += 1;
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) i += 1;
      count += 1;
    }
  }
  const endsWithBreak =
    text.length > 0 &&
    (text.charCodeAt(text.length - 1) === 10 ||
      text.charCodeAt(text.length - 1) === 13);
  if (text.length > 0 && !endsWithBreak) count += 1;

  const starts = new Uint32Array(count);
  const ends = new Uint32Array(count);
  let line = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) {
      starts[line] = start;
      ends[line] = i;
      line += 1;
      if (c === 13 && text.charCodeAt(i + 1) === 10) i += 1;
      start = i + 1;
    }
  }
  if (start < text.length) {
    starts[line] = start;
    ends[line] = text.length;
  }
  return {
    count,
    line(index) {
      if (index < 0 || index >= count) return "";
      return text.slice(starts[index] ?? 0, ends[index] ?? 0);
    },
  };
}
