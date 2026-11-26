// コアのキーの既定値（設計書 3.4）。一覧は core-commands.ts の `keys`。
import { CORE_COMMANDS } from "../commands/core-commands";
import type { RawKeybinding } from "../types";

export function defaultKeybindings(): RawKeybinding[] {
  return CORE_COMMANDS.flatMap((command) =>
    (command.keys ?? []).map((entry) => {
      const binding: RawKeybinding = { key: entry.key, command: command.id };
      if (entry.when !== undefined) binding.when = entry.when;
      return binding;
    }),
  );
}
