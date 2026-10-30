import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./args";

export const DEFAULT_URL = "http://localhost:8787";

/**
 * How to reach one server. A profile holds an API key (the data API only) or a session from
 * signing in with an email address (everything, as in the console). Never both.
 */
export interface Profile {
  url?: string;
  apiKey?: string;
  session?: string;
  email?: string;
  workspace?: { id: string; name: string };
  environment?: { id: string; name: string };
}

export interface ConfigFile {
  current?: string;
  profiles: Record<string, Profile>;
}

const configPath = () => process.env.KAIROS_CONFIG || join(homedir(), ".kairos", "config.json");

export function readConfig(): ConfigFile {
  const path = configPath();
  if (!existsSync(path)) return { profiles: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigFile>;
    return { current: parsed.current, profiles: parsed.profiles ?? {} };
  } catch {
    throw new CliError(`${path} is not valid JSON. Correct it, or remove it and sign in again.`);
  }
}

export function writeConfig(config: ConfigFile): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // `mode` applies only when the file is created, and the file holds keys and sessions.
  chmodSync(path, 0o600);
}

export function updateProfile(name: string, change: (profile: Profile) => Profile | undefined): void {
  const config = readConfig();
  const next = change(config.profiles[name] ?? {});
  if (next) config.profiles[name] = next;
  else delete config.profiles[name];
  writeConfig(config);
}

export const profileName = (flag: string | undefined) =>
  flag || process.env.KAIROS_PROFILE || readConfig().current || "default";

export interface Connection {
  url: string;
  apiKey?: string;
  session?: string;
  workspace?: string;
  environment?: string;
}

/** A flag wins over the environment, and the environment over the profile. */
export function connection(profile: Profile, urlFlag?: string): Connection {
  const envKey = process.env.KAIROS_API_KEY || undefined;
  const url = urlFlag || process.env.KAIROS_URL || profile.url || DEFAULT_URL;
  return {
    url: url.replace(/\/+$/, ""),
    apiKey: envKey ?? profile.apiKey,
    session: envKey ? undefined : profile.session,
    workspace: profile.workspace?.id,
    environment: profile.environment?.id,
  };
}
