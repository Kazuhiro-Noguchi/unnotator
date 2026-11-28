// `index.tsx` の最初に読み込む。`App` の読み込み中のエラーも拾うため、別のモジュールにして先に実行する。
import { forwardConsole } from "./console-forward";

forwardConsole();
