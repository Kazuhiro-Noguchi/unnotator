// 枠の中の例外を本体へ報告する。

export interface ErrorReport {
  phase:
    | "import"
    | "activate"
    | "surface"
    | "error"
    | "unhandledrejection"
    | "call";
  message: string;
  stack?: string;
}

export function toReport(
  phase: ErrorReport["phase"],
  error: unknown,
): ErrorReport {
  if (error instanceof Error) {
    const report: ErrorReport = { phase, message: error.message };
    if (typeof error.stack === "string")
      report.stack = error.stack.slice(0, 2000);
    return report;
  }
  return { phase, message: String(error).slice(0, 500) };
}

export interface ErrorTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/** `error` と `unhandledrejection` を拾って報告する。戻り値で外せる。 */
export function installErrorReporting(
  win: ErrorTarget,
  report: (r: ErrorReport) => void,
): () => void {
  const onError = (event: Event) => {
    const e = event as ErrorEvent;
    report(
      e.error instanceof Error
        ? {
            ...toReport("error", e.error),
            message: e.message || e.error.message,
          }
        : { phase: "error", message: e.message ?? "error" },
    );
  };
  const onRejection = (event: Event) => {
    report(
      toReport("unhandledrejection", (event as PromiseRejectionEvent).reason),
    );
  };
  win.addEventListener("error", onError);
  win.addEventListener("unhandledrejection", onRejection);
  return () => {
    win.removeEventListener("error", onError);
    win.removeEventListener("unhandledrejection", onRejection);
  };
}
