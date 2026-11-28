import { startFrame } from "./bootstrap";

// 枠の起動用ページから読み込まれる入り口。拡張機能の読み込みは動的 import で行う。
startFrame({
  win: window,
  doc: document,
  importModule: (url) => import(/* @vite-ignore */ url),
});
