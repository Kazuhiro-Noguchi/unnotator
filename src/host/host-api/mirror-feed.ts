// 写し（mirror）を枠へ押し込む（research.md R2）。権限のない値は、最初の値にも差分にも入れない。
import { type HostState, MIRROR_KEYS, type MirrorKey } from "./state";

export interface MirrorFeedDeps {
  state: HostState;
  /** 権限があるか（宣言あり・同意済み）。 */
  allowed(extId: string, permission: string): Promise<boolean>;
  /** マニフェストの `settings` で宣言したキー。 */
  declaredSettings(extId: string): string[];
}

export interface MirrorFeed {
  /** 枠の最初の `mirror`。 */
  snapshot(extId: string): Promise<Record<MirrorKey, unknown>>;
  /** 差分を `emit(key, value)` へ流す。戻り値で止める。 */
  attach(
    extId: string,
    emit: (key: string, value: unknown) => void,
  ): () => void;
}

const EMPTY: Record<MirrorKey, unknown> = {
  selection: [],
  "labels.active": null,
  settings: {},
  "assets.current": null,
  "tools.active": null,
};

/** 値を読むのに要る権限。 */
const REQUIRES: Partial<Record<MirrorKey, string>> = {
  "labels.active": "labels.read",
  "assets.current": "assets.read",
};

function pick(all: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof all !== "object" || all === null) return out;
  for (const key of keys) {
    if (key in all) out[key] = (all as Record<string, unknown>)[key];
  }
  return out;
}

export function createMirrorFeed(deps: MirrorFeedDeps): MirrorFeed {
  /** 枠に見せる値。権限が無ければ `undefined`。 */
  async function visible(
    extId: string,
    key: MirrorKey,
    value: unknown,
  ): Promise<unknown | undefined> {
    const permission = REQUIRES[key];
    if (permission !== undefined && !(await deps.allowed(extId, permission)))
      return undefined;
    if (key === "settings") return pick(value, deps.declaredSettings(extId));
    return value;
  }

  return {
    async snapshot(extId) {
      const out = { ...EMPTY };
      for (const key of MIRROR_KEYS) {
        const value = await visible(extId, key, deps.state.get(key));
        if (value !== undefined) out[key] = value;
      }
      return out;
    },
    attach(extId, emit) {
      let active = true;
      const lastSettings = { text: JSON.stringify(visibleSync(deps, extId)) };
      const offs = MIRROR_KEYS.map((key) =>
        deps.state.subscribe(key, (value) => {
          void (async () => {
            const shown = await visible(extId, key, value);
            if (!active || shown === undefined) return;
            if (key === "settings") {
              const text = JSON.stringify(shown);
              if (text === lastSettings.text) return;
              lastSettings.text = text;
            }
            emit(key, shown);
          })();
        }),
      );
      return () => {
        active = false;
        for (const off of offs) off();
      };
    },
  };
}

function visibleSync(deps: MirrorFeedDeps, extId: string): unknown {
  return pick(deps.state.get("settings"), deps.declaredSettings(extId));
}
