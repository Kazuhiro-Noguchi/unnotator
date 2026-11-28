// 開発中のアプリ（`pnpm tauri dev`）を、確実な合図で操作する補助（macOS 専用）。
// 使い方: node scripts/dev/ui.mjs <コマンド> [引数]
//   mark                    ログの「画面が出た」合図の数を覚える（再起動を待つ前に呼ぶ）
//   wait-ready [秒]         mark のあと、新しい合図（UNNOTATOR_READY）が出るまで待つ。既定 120 秒
//   window                  メインウィンドウの `ID X Y W H`
//   shot <out.png>          メインウィンドウのスクリーンショット
//   click <x> <y>           ウィンドウ内の座標（点。左上が 0,0）をクリック
//   open-project <path>     「既存プロジェクトを開く」ダイアログでフォルダを選ぶ（プロジェクトが未オープンのとき）
// ログは UNNO_DEV_LOG（既定は一時フォルダの unnotator-dev.log）。`pnpm tauri dev > $UNNO_DEV_LOG 2>&1 &` で起動する。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOG = process.env.UNNO_DEV_LOG ?? join(tmpdir(), "unnotator-dev.log");
const MARK = join(tmpdir(), "unnotator-dev.mark");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const countReady = () => {
  try {
    return (readFileSync(LOG, "utf8").match(/UNNOTATOR_READY/g) ?? []).length;
  } catch {
    return 0;
  }
};
const swift = (file, ...args) =>
  spawnSync("swift", [`${here}/${file}`, ...args], { encoding: "utf8" });
const windowInfo = () => {
  const out = swift("window.swift").stdout.trim().split(" ").map(Number);
  return out.length === 5 && out.every(Number.isFinite)
    ? { id: out[0], x: out[1], y: out[2], w: out[3], h: out[4] }
    : null;
};

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "mark":
    writeFileSync(MARK, String(countReady()));
    console.log(`合図の数: ${countReady()}`);
    break;
  case "wait-ready": {
    const since = Number(readFileSync(MARK, "utf8"));
    const limit = Date.now() + Number(args[0] ?? 120) * 1000;
    while (countReady() <= since) {
      if (Date.now() > limit) {
        console.error("時間切れ: 画面が出た合図が来ない");
        process.exit(1);
      }
      await sleep(500);
    }
    console.log("画面が出た");
    break;
  }
  case "window": {
    const w = windowInfo();
    console.log(w ? `${w.id} ${w.x} ${w.y} ${w.w} ${w.h}` : "ウィンドウが無い");
    process.exit(w ? 0 : 1);
    break;
  }
  case "shot": {
    const w = windowInfo();
    if (!w) {
      console.error("ウィンドウが無い");
      process.exit(1);
    }
    spawnSync("screencapture", ["-x", "-l", String(w.id), args[0]]);
    console.log(args[0]);
    break;
  }
  case "click": {
    const w = windowInfo();
    if (!w) {
      console.error("ウィンドウが無い");
      process.exit(1);
    }
    swift(
      "click.swift",
      String(w.x + Number(args[0])),
      String(w.y + Number(args[1])),
    );
    break;
  }
  case "open-project": {
    spawnSync("sh", ["-c", `printf %s '${args[0]}' | pbcopy`]);
    // 「既存プロジェクトを開く」→ Cmd+Shift+G → 貼り付け → 移動 → 開く
    const w = windowInfo();
    if (!w) process.exit(1);
    swift(
      "click.swift",
      String(w.x + Number(args[1] ?? 155)),
      String(w.y + Number(args[2] ?? 330)),
    );
    await sleep(2000);
    for (const [k, f] of [
      ["5", "1179648"],
      ["0", "1048576"],
      ["9", "1048576"],
    ]) {
      swift("key.swift", k, f);
      await sleep(700);
    }
    for (let i = 0; i < 2; i++) {
      swift("key.swift", "36");
      await sleep(1500);
    }
    break;
  }
  default:
    console.error(
      "コマンド: mark | wait-ready | window | shot | click | open-project",
    );
    process.exit(2);
}
