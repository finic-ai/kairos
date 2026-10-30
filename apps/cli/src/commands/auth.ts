import { CliError, parse } from "../args";
import { Client, sessionFrom } from "../client";
import { connection, DEFAULT_URL, readConfig, updateProfile, writeConfig, type Profile } from "../config";
import type { Command, Context } from "../context";
import { bold, dim, fields, green, show, table } from "../output";
import { ask, askSecret, choose, interactive } from "../prompt";

interface Environment {
  id: string;
  name: string;
  kind: string;
}

interface Workspace {
  id: string;
  name: string;
  role: string;
  environments?: Environment[];
}

interface Me {
  user: { id: string; email: string; name?: string };
  workspaces: Workspace[];
}

async function pick(
  workspaces: Workspace[],
  wanted: { workspace?: string; environment?: string },
): Promise<Pick<Profile, "workspace" | "environment">> {
  if (workspaces.length === 0) throw new CliError("This account is not in any workspace.");
  const match = <T extends { id: string; name: string }>(items: T[], value: string, what: string): T => {
    const found =
      items.find((item) => item.id === value) ?? items.find((item) => item.name.toLowerCase() === value.toLowerCase());
    if (!found) throw new CliError(`No ${what} "${value}". There is: ${items.map((item) => item.name).join(", ")}`);
    return found;
  };
  const workspace = wanted.workspace
    ? match(workspaces, wanted.workspace, "workspace")
    : workspaces.length === 1 || !interactive()
      ? workspaces[0]!
      : await choose("Workspace", workspaces, (w) => `${w.name} ${dim(`(${w.role})`)}`);
  const environments = workspace.environments ?? [];
  const environment = wanted.environment
    ? match(environments, wanted.environment, "environment")
    : environments.find((e) => e.kind === "production");
  return {
    workspace: { id: workspace.id, name: workspace.name },
    environment: environment ? { id: environment.id, name: environment.name } : undefined,
  };
}

async function signIn(url: string, path: "/auth/login" | "/auth/signup", body: object) {
  const client = new Client({ url });
  const { data, response } = await client.send<Me>("POST", path, { body, anonymous: true });
  const session = sessionFrom(response);
  if (!session) throw new CliError("The server did not start a session.");
  return { me: data, session };
}

async function saveSession(
  ctx: Context,
  url: string,
  { me, session }: { me: Me; session: string },
  values: { workspace?: string; environment?: string },
) {
  const choice = await pick(me.workspaces, values);
  updateProfile(ctx.profile, () => ({ url, session, email: me.user.email, ...choice }));
  setCurrent(ctx.profile);
  show(ctx.json, { profile: ctx.profile, url, email: me.user.email, ...choice }, () =>
    console.log(
      `${green("Signed in")} as ${bold(me.user.email)} on ${url} ${dim("·")} workspace ${bold(choice.workspace!.name)}${choice.environment ? ` ${dim("·")} ${choice.environment.name}` : ""}`,
    ),
  );
}

function setCurrent(name: string) {
  const config = readConfig();
  if (config.current === name) return;
  config.current = name;
  writeConfig(config);
}

const urlOf = (ctx: Context) => connection(ctx.stored(), ctx.url).url;

export const login: Command = async (args, ctx) => {
  const { values } = parse(args, {
    key: { type: "string", short: "k" },
    email: { type: "string", short: "e" },
    workspace: { type: "string" },
    environment: { type: "string" },
  });
  const url = urlOf(ctx);
  let { key, email } = values;
  if (!key && !email) {
    const answer = await ask(`Email address or API key for ${url}: `);
    if (/^k[sp]k_/.test(answer)) key = answer;
    else email = answer;
  }

  if (key) {
    if (key.startsWith("kpk_"))
      throw new CliError("A public key (kpk_…) can only send events. Use a secret key (ksk_…).");
    await new Client({ url, apiKey: key }).request("GET", "/v1/stats");
    updateProfile(ctx.profile, () => ({ url, apiKey: key }));
    setCurrent(ctx.profile);
    show(ctx.json, { profile: ctx.profile, url, auth: "api_key" }, () =>
      console.log(`${green("Signed in")} with an API key on ${url} ${dim(`(profile ${ctx.profile})`)}`),
    );
    return;
  }

  if (!email) throw new CliError("Give an email address or an API key.");
  const password = await askSecret("Password: ");
  await saveSession(ctx, url, await signIn(url, "/auth/login", { email, password }), values);
};

export const signup: Command = async (args, ctx) => {
  const { values } = parse(args, {
    email: { type: "string", short: "e" },
    name: { type: "string" },
    invite: { type: "string" },
  });
  const url = urlOf(ctx);
  const email = values.email ?? (await ask("Email address: "));
  const password = await askSecret("Password (at least 8 characters): ");
  if (interactive() && (await askSecret("Password again: ")) !== password)
    throw new CliError("The two passwords are not the same.");
  const body = {
    email,
    password,
    ...(values.name ? { name: values.name } : {}),
    ...(values.invite ? { invite: values.invite } : {}),
  };
  await saveSession(ctx, url, await signIn(url, "/auth/signup", body), {});
};

export const logout: Command = async (args, ctx) => {
  parse(args, {});
  const client = ctx.client();
  if (client.hasSession) await client.request("POST", "/auth/logout").catch(() => {});
  updateProfile(ctx.profile, (profile) =>
    profile.url && profile.url !== DEFAULT_URL ? { url: profile.url } : undefined,
  );
  console.log(`Signed out ${dim(`(profile ${ctx.profile})`)}`);
};

export const whoami: Command = async (args, ctx) => {
  parse(args, {});
  const client = ctx.client();
  const { url, apiKey, session } = client.conn;
  const stored = ctx.stored();
  const health = await client
    .request<{ ok: boolean }>("GET", "/health", { anonymous: true })
    .then(() => "up")
    .catch(() => "not reachable");
  const me = session && !apiKey ? await client.request<Me>("GET", "/auth/me").catch(() => undefined) : undefined;
  const status = {
    profile: ctx.profile,
    url,
    server: health,
    auth: apiKey ? (process.env.KAIROS_API_KEY ? "api_key (KAIROS_API_KEY)" : "api_key") : session ? "session" : "none",
    email: me?.user.email,
    workspace: !apiKey ? stored.workspace : undefined,
    environment: !apiKey ? stored.environment : undefined,
  };
  show(ctx.json, status, () => {
    fields([
      ["profile", status.profile],
      ["server", `${url} ${status.server === "up" ? green("up") : dim(status.server)}`],
      ["signed in", status.auth === "none" ? dim('no: run "kairos login"') : status.auth],
      ...(session && !apiKey
        ? ([
            ["email", me?.user.email ?? dim("the session has ended: run kairos login")],
            ["workspace", status.workspace?.name],
            ["environment", status.environment?.name ?? "Production"],
          ] as [string, unknown][])
        : []),
    ]);
  });
};

export const use: Command = async (args, ctx) => {
  const { values } = parse(args, {
    workspace: { type: "string" },
    environment: { type: "string" },
  });
  const client = ctx.client();
  if (!client.hasSession)
    throw new CliError(
      `Workspaces are chosen with a session. Sign in with "kairos login --email". An API key belongs to one workspace.`,
    );
  const me = await client.request<Me>("GET", "/auth/me");
  if (!values.workspace && !values.environment) {
    const stored = ctx.stored();
    show(ctx.json, me.workspaces, () =>
      table(
        me.workspaces.flatMap((w) =>
          (w.environments ?? []).map((e) => ({
            w,
            e,
            current:
              stored.workspace?.id === w.id &&
              (stored.environment ? stored.environment.id === e.id : e.kind === "production"),
          })),
        ),
        [
          ["", (r) => (r.current ? green("*") : "")],
          ["WORKSPACE", (r) => r.w.name],
          ["ENVIRONMENT", (r) => r.e.name],
          ["ROLE", (r) => r.w.role],
          ["WORKSPACE ID", (r) => r.w.id],
          ["ENVIRONMENT ID", (r) => r.e.id],
        ],
      ),
    );
    return;
  }
  const choice = await pick(me.workspaces, {
    workspace: values.workspace ?? ctx.stored().workspace?.id,
    environment: values.environment,
  });
  updateProfile(ctx.profile, (profile) => ({ ...profile, ...choice }));
  show(ctx.json, choice, () =>
    console.log(
      `Using ${bold(choice.workspace!.name)}${choice.environment ? ` ${dim("·")} ${choice.environment.name}` : ""}`,
    ),
  );
};

export const profiles: Command = async (args, ctx) => {
  const { positionals } = parse(args, {});
  const [sub, name] = positionals;
  const config = readConfig();
  if (sub === "use") {
    if (!name || !config.profiles[name]) throw new CliError(`No profile "${name ?? ""}".`);
    setCurrent(name);
    console.log(`Using profile ${bold(name)}`);
    return;
  }
  if (sub === "remove") {
    if (!name || !config.profiles[name]) throw new CliError(`No profile "${name ?? ""}".`);
    delete config.profiles[name];
    if (config.current === name) delete config.current;
    writeConfig(config);
    console.log(`Removed profile ${bold(name)}`);
    return;
  }
  if (sub && sub !== "list") throw new CliError(`Unknown: kairos profiles ${sub}. Use list, use or remove.`);
  const rows = Object.entries(config.profiles).map(([name, p]) => ({ name, ...p }));
  show(
    ctx.json,
    rows.map(({ apiKey, session, ...rest }) => ({ ...rest, auth: apiKey ? "api_key" : session ? "session" : "none" })),
    () =>
      table(
        rows,
        [
          ["", (r) => (r.name === ctx.profile ? green("*") : "")],
          ["PROFILE", (r) => r.name],
          ["URL", (r) => r.url ?? DEFAULT_URL],
          ["AUTH", (r) => (r.apiKey ? `key ${r.apiKey.slice(0, 8)}…` : r.session ? r.email : "")],
          ["WORKSPACE", (r) => r.workspace?.name],
          ["ENVIRONMENT", (r) => r.environment?.name],
        ],
        'No profiles. Run "kairos login".',
      ),
  );
};
