// 利用側の見本。固めたパッケージを import して、型検査が通る書き方と通らない書き方を確かめる。
import {
  type ActivateFunction,
  API_VERSION,
  type ExtensionModule,
  type Host,
  type Remote,
  type SurfaceHost,
  type SurfaceModule,
} from "@unnotator/plugin-api";

// 正しい書き方
export const activate: ActivateFunction = (host: Host) => {
  void host;
  return {};
};

export const extension: ExtensionModule = { activate };

export const version: "0.0.1" = API_VERSION;

// 誤った書き方（型検査で必ずエラーになる）
// @ts-expect-error activate は host を受け取る関数でなければならない
export const wrongActivate: ActivateFunction = "not a function";

// @ts-expect-error 戻り値は void か object でなければならない
export const wrongReturn: ActivateFunction = () => 42;

// @ts-expect-error API_VERSION は '0.0.1' 以外ではない
export const wrongVersion: "2.0.0" = API_VERSION;

// 画面用モジュール（entry）の正しい書き方
export const surface: SurfaceModule = {
  async openEditor(ctx, host: SurfaceHost) {
    void ctx.container;
    host.log.info("open");
    return { reveal: () => {}, dispose: () => {} };
  },
  async renderPreview() {
    return { dispose: () => {} };
  },
  async resolveView() {
    return { dispose: () => {} };
  },
};

// getApi の戻り値は Remote<T>（メソッドが Promise を返す形）
interface ShapeApi {
  area(id: string): number;
  nested: { name(): string };
}
export async function useApi(host: Host): Promise<number> {
  const api: Remote<ShapeApi> =
    await host.extensions.getApi<ShapeApi>("com.example.shape");
  const name: string = await api.nested.name();
  void name;
  return await api.area("a");
}

// biome-ignore format: 次の行の @ts-expect-error を 1 行に保つ
// @ts-expect-error Remote のメソッドは Promise を返すので、number に直接は代入できない
export const wrongRemote = async (api: Remote<ShapeApi>): Promise<number> => { const n: number = api.area("a"); return n; };

// @ts-expect-error 登録系は画面の枠には渡されない
export const noRegister = (host: SurfaceHost) => host.items.register;

// @ts-expect-error 登録系は画面の枠には渡されない
export const noPython = (host: SurfaceHost) => host.python;

// @ts-expect-error editors の register は Host から無くなった
export const noEditorsRegister = (host: Host) => host.editors;
