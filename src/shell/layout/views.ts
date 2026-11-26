// ビューの差し込み口（specs/006-shell-layout/contracts/shell-api.md）。
// 007 は explorer、008 は labels と info、011 は extensions・output・jobs・problems の中身を差し替える。
import type { JSX } from "solid-js";
import type { MessageKey } from "../../i18n";
import type { Context, Disposable, ProblemSink, Title } from "../types";
import { createWhen } from "../when/parse";

export type ViewLocation = "primarySidebar" | "panel" | "secondarySidebar";

export interface ViewDef {
  id: string;
  title: Title;
  /** `$(name)` またはアイコンの相対パス。sidebar では必須。 */
  icon?: string;
  location: ViewLocation;
  when?: string;
  render: () => JSX.Element;
  source: string;
}

export interface CoreViewMeta {
  id: string;
  location: ViewLocation;
  title: MessageKey;
  empty: MessageKey;
  icon: string;
}

/** コアのビュー。中身が登録されるまでは、空の状態の案内を出す。 */
export const CORE_VIEWS: readonly CoreViewMeta[] = [
  {
    id: "explorer",
    location: "primarySidebar",
    title: "view.explorer.title",
    empty: "empty.explorer",
    icon: "$(explorer)",
  },
  {
    id: "labels",
    location: "primarySidebar",
    title: "view.labels.title",
    empty: "empty.labels",
    icon: "$(tag)",
  },
  {
    id: "search",
    location: "primarySidebar",
    title: "view.search.title",
    empty: "empty.search",
    icon: "$(search)",
  },
  {
    id: "extensions",
    location: "primarySidebar",
    title: "view.extensions.title",
    empty: "empty.extensions",
    icon: "$(extension)",
  },
  {
    id: "output",
    location: "panel",
    title: "view.output.title",
    empty: "empty.output",
    icon: "$(output)",
  },
  {
    id: "jobs",
    location: "panel",
    title: "view.jobs.title",
    empty: "empty.jobs",
    icon: "$(jobs)",
  },
  {
    id: "problems",
    location: "panel",
    title: "view.problems.title",
    empty: "empty.problems",
    icon: "$(problems)",
  },
  {
    id: "info",
    location: "secondarySidebar",
    title: "view.info.title",
    empty: "empty.info",
    icon: "$(info)",
  },
];

export function createViewRegistry(ctx: Context, report: ProblemSink) {
  const views = new Map<string, ViewDef>();
  const conditions = new Map<string, () => boolean>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };

  return {
    /** 同じ ID を登録し直すと、中身が差し替わる（コアの空の状態 → 各機能の中身）。 */
    register(view: ViewDef): Disposable {
      const previous = views.get(view.id);
      views.set(view.id, view);
      conditions.set(view.id, createWhen(view.when, ctx, report, view.source));
      emit();
      return {
        dispose() {
          if (views.get(view.id) !== view) return;
          if (previous) views.set(view.id, previous);
          else views.delete(view.id);
          conditions.delete(view.id);
          emit();
        },
      };
    },
    unregister(source: string): void {
      for (const [id, view] of views) {
        if (view.source === source) {
          views.delete(id);
          conditions.delete(id);
        }
      }
      emit();
    },
    get: (id: string): ViewDef | undefined => views.get(id),
    /** 条件が真のビューだけ。登録順。 */
    list(location: ViewLocation): ViewDef[] {
      return [...views.values()].filter(
        (v) => v.location === location && conditions.get(v.id)?.() !== false,
      );
    },
    ids(location: ViewLocation): string[] {
      return [...views.values()]
        .filter((v) => v.location === location)
        .map((v) => v.id);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type ViewRegistry = ReturnType<typeof createViewRegistry>;
