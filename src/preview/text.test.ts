import { describe, expect, it } from "vitest";
import {
  buildLineIndex,
  CHUNK_BYTES,
  loadTextHead,
  MAX_TEXT_BYTES,
  TextLoadError,
} from "./text";

const MIB = 1024 * 1024;

/** `unno://asset/` のように、Range に応えて、1 応答を 4 MiB までにする偽の fetch。 */
function fakeServer(
  bytes: Uint8Array,
  options: { contentRange?: boolean; ignoreRange?: boolean } = {},
) {
  const calls: string[] = [];
  const fetchFn = async (
    _url: string,
    init?: { headers?: Record<string, string>; signal?: AbortSignal },
  ) => {
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const range = init?.headers?.Range ?? "";
    calls.push(range);
    if (options.ignoreRange) {
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }
    const match = /bytes=(\d+)-(\d+)/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = Math.min(
      match ? Number(match[2]) : bytes.length - 1,
      bytes.length - 1,
      start + 4 * MIB - 1,
    );
    const body = bytes.slice(start, end + 1);
    const headers: Record<string, string> = {};
    if (options.contentRange !== false)
      headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
    return new Response(body as unknown as BodyInit, { status: 206, headers });
  };
  return { fetchFn, calls };
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("loadTextHead", () => {
  it("短い UTF-8 のテキストを、1 回で読む", async () => {
    const server = fakeServer(encode("あいう\nabc\n"));
    const result = await loadTextHead({
      url: "unno://asset/x",
      fetchFn: server.fetchFn,
    });
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("あいう\nabc\n");
    expect(server.calls.length).toBe(1);
  });

  it("空のファイルも読める", async () => {
    const server = fakeServer(new Uint8Array(0));
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("10MB を超えると、先頭の 10MB だけを、4 MiB ずつ 3 回で読み、続きがあると伝える", async () => {
    const big = new Uint8Array(11 * MIB).fill(0x61);
    const server = fakeServer(big);
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_TEXT_BYTES);
    expect(server.calls).toEqual([
      `bytes=0-${CHUNK_BYTES - 1}`,
      `bytes=${CHUNK_BYTES}-${2 * CHUNK_BYTES - 1}`,
      `bytes=${2 * CHUNK_BYTES}-${MAX_TEXT_BYTES - 1}`,
    ]);
  });

  it("ちょうど 10MB なら、切り詰めない", async () => {
    const exact = new Uint8Array(MAX_TEXT_BYTES).fill(0x62);
    const server = fakeServer(exact);
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.truncated).toBe(false);
    expect(result.text.length).toBe(MAX_TEXT_BYTES);
  });

  it("応答の境目をまたぐ多バイトの文字を壊さない", async () => {
    // 4 MiB の境目に「あ」（3 バイト）の先頭が来るように並べる
    const prefix = new Uint8Array(CHUNK_BYTES - 1).fill(0x61);
    const tail = encode("あ終");
    const bytes = new Uint8Array(prefix.length + tail.length);
    bytes.set(prefix);
    bytes.set(tail, prefix.length);
    const server = fakeServer(bytes);
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.text.endsWith("あ終")).toBe(true);
    expect(server.calls.length).toBe(2);
  });

  it("10MB で切るとき、文字の途中で切れても、エラーにしない", async () => {
    const prefix = new Uint8Array(MAX_TEXT_BYTES - 1).fill(0x61);
    const bytes = new Uint8Array(prefix.length + 3);
    bytes.set(prefix);
    bytes.set(encode("あ"), prefix.length);
    const server = fakeServer(bytes);
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_TEXT_BYTES - 1);
  });

  it("UTF-8 ではないバイト列は not-utf8（一部だけを見せない）", async () => {
    const server = fakeServer(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expect(
      loadTextHead({ url: "u", fetchFn: server.fetchFn }),
    ).rejects.toMatchObject({
      reason: "not-utf8",
    });
  });

  it("終わりが不完全な UTF-8（切り詰めていないとき）も not-utf8", async () => {
    const server = fakeServer(new Uint8Array([0x61, 0xe3, 0x81]));
    await expect(
      loadTextHead({ url: "u", fetchFn: server.fetchFn }),
    ).rejects.toBeInstanceOf(TextLoadError);
  });

  it("Content-Range が無くても、読み切れる", async () => {
    const server = fakeServer(encode("abc"), { contentRange: false });
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.text).toBe("abc");
    expect(result.truncated).toBe(false);
  });

  it("Range を無視して全体を返すサーバーでも、先頭の 10MB だけを使う", async () => {
    const big = new Uint8Array(11 * MIB).fill(0x63);
    const server = fakeServer(big, { ignoreRange: true });
    const result = await loadTextHead({ url: "u", fetchFn: server.fetchFn });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(MAX_TEXT_BYTES);
  });

  it("HTTP のエラーは read-failed", async () => {
    await expect(
      loadTextHead({
        url: "u",
        fetchFn: async () => new Response("x", { status: 404 }),
      }),
    ).rejects.toMatchObject({ reason: "read-failed" });
  });

  it("通信の失敗は read-failed", async () => {
    await expect(
      loadTextHead({
        url: "u",
        fetchFn: async () => {
          throw new Error("network");
        },
      }),
    ).rejects.toMatchObject({ reason: "read-failed" });
  });

  it("中断されたら、AbortError で止まる", async () => {
    const controller = new AbortController();
    controller.abort();
    const server = fakeServer(encode("abc"));
    await expect(
      loadTextHead({
        url: "u",
        fetchFn: server.fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("buildLineIndex", () => {
  it("LF・CRLF・CR の混在を、行に分ける", () => {
    const index = buildLineIndex("a\nb\r\nc\rd");
    expect(index.count).toBe(4);
    expect([0, 1, 2, 3].map((i) => index.line(i))).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("末尾の改行の後ろに、空の行を作らない", () => {
    expect(buildLineIndex("a\nb\n").count).toBe(2);
    expect(buildLineIndex("").count).toBe(0);
    expect(buildLineIndex("\n").count).toBe(1);
    expect(buildLineIndex("\n").line(0)).toBe("");
  });

  it("範囲外の行は空", () => {
    const index = buildLineIndex("a");
    expect(index.line(5)).toBe("");
    expect(index.line(-1)).toBe("");
  });

  it("非常に長い 1 行も、そのまま 1 行", () => {
    const long = "x".repeat(200_000);
    const index = buildLineIndex(`${long}\nnext`);
    expect(index.count).toBe(2);
    expect(index.line(0).length).toBe(200_000);
  });

  it("多数の行でも、行の文字列を全部は作らない（索引だけ）", () => {
    const text = "a\n".repeat(500_000);
    const index = buildLineIndex(text);
    expect(index.count).toBe(500_000);
    expect(index.line(499_999)).toBe("a");
  });
});
