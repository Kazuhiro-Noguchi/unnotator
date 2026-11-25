// 利用側の見本。固めたパッケージを import して、型検査が通る書き方と通らない書き方を確かめる。
import {
  type ActivateFunction,
  API_VERSION,
  type ExtensionModule,
  type Host,
} from "@unnotator/plugin-api";

// 正しい書き方
export const activate: ActivateFunction = (host: Host) => {
  void host;
  return {};
};

export const extension: ExtensionModule = { activate };

export const version: "1.0.0" = API_VERSION;

// 誤った書き方（型検査で必ずエラーになる）
// @ts-expect-error activate は host を受け取る関数でなければならない
export const wrongActivate: ActivateFunction = "not a function";

// @ts-expect-error 戻り値は void か object でなければならない
export const wrongReturn: ActivateFunction = () => 42;

// @ts-expect-error API_VERSION は '1.0.0' 以外ではない
export const wrongVersion: "2.0.0" = API_VERSION;
