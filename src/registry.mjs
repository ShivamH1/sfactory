export const commands = new Map();
export function register(name, handler) { commands.set(name, handler); }
