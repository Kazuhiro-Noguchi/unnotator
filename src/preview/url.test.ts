import { describe, expect, it } from "vitest";
import { assetUrl, detectPdfSupport } from "./url";

describe("assetUrl", () => {
  it("macOS・Linux は unno://localhost/、Windows は http://unno.localhost/", () => {
    expect(assetUrl("abc", "Mozilla/5.0 (Macintosh)")).toBe(
      "unno://localhost/asset/abc",
    );
    expect(assetUrl("abc", "Mozilla/5.0 (X11; Linux x86_64)")).toBe(
      "unno://localhost/asset/abc",
    );
    expect(assetUrl("abc", "Mozilla/5.0 (Windows NT 10.0)")).toBe(
      "http://unno.localhost/asset/abc",
    );
  });

  it("ID の特殊な文字は、符号化する（パスから出られない）", () => {
    expect(assetUrl("a/b?c", "Mac")).toBe("unno://localhost/asset/a%2Fb%3Fc");
  });
});

describe("detectPdfSupport", () => {
  it("pdfViewerEnabled があれば、それに従う", () => {
    expect(
      detectPdfSupport({ pdfViewerEnabled: true, userAgent: "Linux" }),
    ).toBe(true);
    expect(
      detectPdfSupport({ pdfViewerEnabled: false, userAgent: "Mac" }),
    ).toBe(false);
  });

  it("無ければ、Linux だけ非対応とみなす", () => {
    expect(
      detectPdfSupport({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }),
    ).toBe(false);
    expect(detectPdfSupport({ userAgent: "Mozilla/5.0 (Macintosh)" })).toBe(
      true,
    );
    expect(
      detectPdfSupport({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" }),
    ).toBe(true);
    expect(detectPdfSupport({})).toBe(true);
  });
});
