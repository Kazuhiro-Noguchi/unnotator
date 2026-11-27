// ラベルのコマンドを、アプリの実体につなぐ。
import type { CommandRegistry } from "../commands/registry";
import { explorer, itemSource } from "../explorer/instance";
import {
  projectData,
  readClassificationMultiple,
} from "../project-data/instance";
import type { Disposable, NotifyLevel } from "../types";
import { provideLabelHandlers } from "./commands";

export function provideLabelCommands(
  registry: CommandRegistry,
  notify: (level: NotifyLevel, text: string) => void,
): Disposable {
  return provideLabelHandlers({
    commands: registry,
    data: projectData,
    current: explorer.current,
    multiple: readClassificationMultiple,
    providerOf: (mediaType) => itemSource.traitsOf(mediaType).provider,
    notify,
  });
}
