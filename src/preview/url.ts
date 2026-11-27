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
