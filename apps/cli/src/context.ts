import { CliError } from "./args";
import type { Client } from "./client";
import type { Profile } from "./config";

export interface Context {
  json: boolean;
  profile: string;
  url?: string;
  stored(): Profile;
  client(): Client;
}

export type Command = (args: string[], ctx: Context) => Promise<void>;

/** `kairos <group> <sub> …`. With no sub, or an option first, it is `list`. */
export function group(name: string, subs: Record<string, Command>): Command {
  return async (args, ctx) => {
    const [first, ...rest] = args;
    const [sub, subArgs] = !first || first.startsWith("-") ? ["list", args] : [first, rest];
    const run = subs[sub];
    if (!run) throw new CliError(`Unknown: kairos ${name} ${sub}. Use ${Object.keys(subs).join(", ")}.`);
    await run(subArgs, ctx);
  };
}

export function need(value: string | undefined, usage: string): string {
  if (!value) throw new CliError(`Usage: kairos ${usage}`);
  return value;
}

export const path = (...parts: string[]) => parts.map(encodeURIComponent).join("/");
