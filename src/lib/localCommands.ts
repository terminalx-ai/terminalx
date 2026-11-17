import { files as filesApi } from "@/lib/api";
import type { ComposerCommandList, ComposerCommands } from "@/lib/cloudComposer";

const commandCache = new Map<string, ComposerCommandList>();

const commandsAsked = new Map<string, Promise<ComposerCommandList>>();

/** A local tab's commands: asked of the harness once per directory. */
export function localCommands(cwd: string, harness: string): ComposerCommands {
  const key = `${cwd}|${harness}`;
  return {
    key,
    known: () => commandCache.get(key) ?? null,
    load: () => {
      const known = commandCache.get(key);
      if (known) return Promise.resolve(known);
      const pending = commandsAsked.get(key);
      if (pending) return pending;
      const asked = filesApi
        .slashCommands(cwd, harness)
        .then((commands) => {
          const list = { commands, note: null };
          commandCache.set(key, list);
          return list;
        })
        .finally(() => commandsAsked.delete(key));
      commandsAsked.set(key, asked);
      return asked;
    },
  };
}
