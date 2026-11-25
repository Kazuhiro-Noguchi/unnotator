// S-01 の自己診断（実機の WebView で `unno://` の配信を確かめる）。Rust が `window.__UNNO_SELFTEST__` を渡して実行する。
// 結果は IPC の `report_selftest` で Rust に戻る。アプリの CSP のもとで動くので、CSP の設定の確認も兼ねる。
(async () => {
  const cfg = window.__UNNO_SELFTEST__;
  const base = cfg.base;
  const results = {};
  const now = () => performance.now();

  async function step(name, fn) {
    const started = now();
    try {
      const value = (await fn()) ?? {};
      results[name] = { ok: value.ok !== false, ms: Math.round(now() - started), ...value };
    } catch (error) {
      results[name] = { ok: false, ms: Math.round(now() - started), error: String(error) };
    }
  }

  // 本体の位置 i のバイトは (i % 251)。読んだ中身を確かめる
  const patternOk = (bytes, offset) => {
    for (let i = 0; i < bytes.length; i += Math.max(1, Math.floor(bytes.length / 64))) {
      if (bytes[i] !== (offset + i) % 251) return false;
    }
    return true;
  };

  const ranged = (url, range) => fetch(url, { headers: { Range: range } });

  await step("fetch-full", async () => {
    const r = await fetch(`${base}/asset/${cfg.smallId}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return {
      ok: r.status === 200 && bytes.length === cfg.smallSize && patternOk(bytes, 0),
      status: r.status,
      length: bytes.length,
      contentType: r.headers.get("content-type"),
    };
  });

  await step("range-head", async () => {
    const r = await ranged(`${base}/asset/${cfg.bigId}`, "bytes=0-1023");
    const bytes = new Uint8Array(await r.arrayBuffer());
    return {
      ok: r.status === 206 && bytes.length === 1024 && patternOk(bytes, 0),
      status: r.status,
      contentRange: r.headers.get("content-range"),
    };
  });

  await step("range-middle-1mib", async () => {
    const start = Math.floor(cfg.bigSize / 2);
    const started = now();
    const r = await ranged(`${base}/asset/${cfg.bigId}`, `bytes=${start}-${start + 1048575}`);
    const firstByteMs = Math.round(now() - started);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return {
      ok: r.status === 206 && bytes.length === 1048576,
      status: r.status,
      firstByteMs,
      contentRange: r.headers.get("content-range"),
    };
  });

  await step("range-suffix", async () => {
    const r = await ranged(`${base}/asset/${cfg.bigId}`, "bytes=-16");
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { ok: r.status === 206 && bytes.length === 16, status: r.status };
  });

  await step("range-open-ended-is-cut", async () => {
    const r = await ranged(`${base}/asset/${cfg.bigId}`, "bytes=0-");
    const bytes = new Uint8Array(await r.arrayBuffer());
    return { ok: r.status === 206 && bytes.length === 4 * 1024 * 1024, status: r.status, length: bytes.length };
  });

  await step("range-unsatisfiable", async () => {
    const r = await ranged(`${base}/asset/${cfg.smallId}`, `bytes=${cfg.smallSize + 10}-`);
    return { ok: r.status === 416, status: r.status, contentRange: r.headers.get("content-range") };
  });

  await step("whole-big-file-is-refused", async () => {
    const r = await fetch(`${base}/asset/${cfg.bigId}`);
    return { ok: r.status === 413, status: r.status };
  });

  await step("etag-304", async () => {
    const first = await fetch(`${base}/asset/${cfg.smallId}`);
    const etag = first.headers.get("etag");
    const again = await fetch(`${base}/asset/${cfg.smallId}`, { headers: { "If-None-Match": etag } });
    return { ok: !!etag && again.status === 304, etag, status: again.status };
  });

  await step("blob", async () => {
    const r = await fetch(`${base}/blob/${cfg.blobName}`);
    const text = await r.text();
    return { ok: r.status === 200 && text === "blob-ok", status: r.status };
  });

  await step("escape-is-refused", async () => {
    // ブラウザが先に整える場合もあるので、「中身が返らない」ことを確かめる
    const r = await fetch(`${base}/ext/${cfg.extId}/%2e%2e/%2e%2e/secret.txt`);
    const text = await r.text();
    return { ok: r.status !== 200 && !text.includes("secret"), status: r.status };
  });

  await step("es-module-under-csp", async () => {
    const module = await import(/* @vite-ignore */ `${base}/ext/${cfg.extId}/dist/index.js`);
    return { ok: module.answer === 42 };
  });

  await step("media-element-range", async () => {
    const audio = new Audio();
    audio.preload = "auto";
    const loaded = new Promise((resolve, reject) => {
      audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
      audio.addEventListener("error", () => reject(new Error(`media error ${audio.error?.code}`)), { once: true });
    });
    audio.src = `${base}/asset/${cfg.toneId}`;
    await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000))]);
    const duration = audio.duration;
    const seeked = new Promise((resolve) => audio.addEventListener("seeked", () => resolve(), { once: true }));
    audio.currentTime = duration / 2;
    await Promise.race([seeked, new Promise((resolve) => setTimeout(resolve, 3000))]);
    return { ok: duration > 0.4 && duration < 0.6, duration };
  });

  await step("concurrent-8-reads-and-frame-gaps", async () => {
    let maxGap = 0;
    let last = now();
    let running = true;
    const tick = () => {
      const t = now();
      maxGap = Math.max(maxGap, t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const started = now();
    const reads = [];
    for (let i = 0; i < 8; i += 1) {
      const start = i * 64 * 1024 * 1024;
      reads.push(
        ranged(`${base}/asset/${cfg.bigId}`, `bytes=${start}-${start + 4 * 1024 * 1024 - 1}`).then((r) => r.arrayBuffer()),
      );
    }
    const buffers = await Promise.all(reads);
    running = false;
    return {
      ok: buffers.every((b) => b.byteLength === 4 * 1024 * 1024),
      totalMs: Math.round(now() - started),
      maxFrameGapMs: Math.round(maxGap),
    };
  });

  await window.__TAURI_INTERNALS__.invoke("report_selftest", { report: JSON.stringify({ results, userAgent: navigator.userAgent }) });
})().catch(async (error) => {
  await window.__TAURI_INTERNALS__.invoke("report_selftest", {
    report: JSON.stringify({ results: { fatal: { ok: false, error: String(error) } }, userAgent: navigator.userAgent }),
  });
});
