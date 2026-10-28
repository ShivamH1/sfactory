export const commands = new Map();
/** name -> { verbs: string[] | null, flags: string[] }: what a command accepts, declared beside its handler. */
export const usages = new Map();
export function register(name, handler, usage = null) {
  commands.set(name, handler);
  if (usage) usages.set(name, { verbs: usage.verbs ?? null, flags: [...(usage.flags ?? [])] });
}
