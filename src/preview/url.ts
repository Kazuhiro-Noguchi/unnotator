// アセットを読む URL。Tauri のカスタムプロトコルは、ホストが `localhost` で、パスが `/asset/<id>` の形
// （`unno_protocol.rs` が `/asset/<id>` として解釈する）。Windows の WebView2 は、独自のスキームを
// `http://unno.localhost/...` として扱う（Tauri の既定。CSP にも両方を許している）。

export function assetUrl(
  assetId: string,
  platform: string = typeof navigator === "undefined"
    ? ""
    : navigator.userAgent,
  options: { display?: boolean } = {},
): string {
  const id = encodeURIComponent(assetId);
  // `display`: `<img>`・`<iframe>` で表示するとき。拡張機能が種別を宣言していなくても表示できるよう、
  // 拡張子から表示用の種別を付けてもらう（`unno_protocol.rs`）。
  const query = options.display ? "?preview=1" : "";
  return /windows/i.test(platform)
    ? `http://unno.localhost/asset/${id}${query}`
    : `unno://localhost/asset/${id}${query}`;
}

/** PDF を、WebView が表示できるか。`navigator.pdfViewerEnabled` があればそれに従い、無ければ OS で決める。 */
export function detectPdfSupport(
  env: { pdfViewerEnabled?: boolean; userAgent?: string } = typeof navigator ===
  "undefined"
    ? {}
    : navigator,
): boolean {
  if (typeof env.pdfViewerEnabled === "boolean") return env.pdfViewerEnabled;
  // Linux の WebKitGTK は、PDF を表示できない見込み（実機で確認する。specs/007 の research.md R7）。
  return (
    !/linux/i.test(env.userAgent ?? "") || /android/i.test(env.userAgent ?? "")
  );
}
