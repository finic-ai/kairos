import { CliError } from "./args";
import { Client } from "./client";
import { connection, profileName, readConfig } from "./config";
import type { Command, Context } from "./context";
import { bold, dim, red } from "./output";
import * as admin from "./commands/admin";
import * as auth from "./commands/auth";
import * as data from "./commands/data";
import * as run from "./commands/run";
import * as cases from "./commands/cases";
import { IMPORT_HELP, importHistory } from "./commands/import";
import { models } from "./commands/models";
import { workflows } from "./commands/workflows";

const HELP = `${bold("kairos")}: start Kairos, connect to a Kairos server (local or production), and work with it from the terminal.

${bold("Start Kairos")} ${dim("(from a checkout of the repository)")}
  kairos dev [--port 8787] [--console-port 5273] [--watch] [--worker]
                                     The API and the console together
  kairos server [--port 8787] [--watch] [--worker inline|separate]
                                     The API
  kairos console [--port 5273] [--api http://localhost:8787]
                                     The console, in development
  kairos worker                      The background jobs, for KAIROS_WORKER=separate
  kairos migrate                     Apply the database migrations

${bold("Connect to a server")} ${dim("(each connection is a profile: kairos login --profile prod --url https://…)")}
  kairos login [--email you@example.com | --key ksk_…] [--workspace name] [--environment name]
  kairos signup [--email you@example.com] [--name "Your Name"]
  kairos logout
  kairos whoami                      The server, the profile and who you are
  kairos use [--workspace name] [--environment name]
  kairos profiles [list | use <name> | remove <name>]

${bold("Work with the server")}
  kairos track <event type> -e user=u_42 [-p amount=120] [--session s] [--ts time]
  kairos track --file events.jsonl   Send a file of events that are in the API's form already
  kairos import events <file.csv> --type transaction --ts created_at [--id txn_id] [--entity user=customer]
  kairos import entities <file.csv> --type user [--id customer_id]
  kairos import labels <file.csv> --entity user=customer_id --label chargeback [--ts reported_at]
                                     Load history from CSV or JSON lines. See "kairos import --help"
  kairos decide <action> -e user=u_42 [-p amount=900] [--session s]
  kairos label <type:id> <label> [-p source=chargeback]
  kairos decisions [list | get <id> | resolve <id> approve|block [--note text]]
  kairos entities [list [--type user] | get <type> <id> | set <type> <id> -p name=value [--unset name]]
  kairos entity-types [list | get <type> | shape <type> | define <type> --data @file.json]
  kairos actions [list | get <name> | define <name> --data @action.json | templates]
  kairos sessions [list | get <id>]
  kairos workflows [list | get <name> | define <name> --data @workflow.json [--draft] | publish <name>]
  kairos workflows [pause <name> | activate <name> | runs <name> | status <run id> | cancel <run id>]
  kairos workflows run <name> [-i user=u_42] [--data @input.json] [--wait] [--key idempotency-key]
  kairos models [list [--kind scoring] [--q loan] [--limit 100] | get <slug>[@version]]
  kairos models upload <slug> (--upload upload.json | --file model.json --samples samples.json) [--name "Loan default"]
  kairos models score <slug>[@version] -f hardship=0.8 [-f amount=6000]
  kairos models promote <slug>[@version] --to <environment>
                                     The same file, as a new version in another environment. Needs kairos login --email
  kairos queues [list | get <queue>]
  kairos cases list <queue> [--status open|in_review|resolved|unresolved] [--assignee me|none] [--overdue]
  kairos cases [get <id> | take <id> | assign <id> <email|user id|none> | note <id> "text" | reopen <id>]
  kairos cases resolve <id> <approved|blocked|confirmed_fraud|false_positive|no_action> [--note text]
  kairos stats
  kairos usage [--days 30]
  kairos api <METHOD> <path> [--data '{…}'] [--query name=value]
                                     Any endpoint. /app/workspaces/- is the current workspace

${bold("Workspace")} ${dim("(signed in with an email address)")}
  kairos workspaces [list | create <name>]
  kairos environments
  kairos keys [list [--all] | create <name> [--kind secret|public] | revoke <id>]
  kairos jobs [list [--status dead] [--kind webhook.deliver] | summary | get <id> | retry <id>]

${bold("Options for every command")}
  --json             Print the JSON of the API
  --profile <name>   Use another saved profile (or KAIROS_PROFILE)
  --url <url>        Use another server (or KAIROS_URL)
  -h, --help         Show this

KAIROS_API_KEY, when set, is used in place of the profile's credentials.
The profiles are in ~/.kairos/config.json (or KAIROS_CONFIG).`;

const COMMANDS: Record<string, Command> = {
  dev: run.dev,
  server: run.server,
  api: data.api,
  console: run.consoleApp,
  worker: run.worker,
  migrate: run.migrate,
  login: auth.login,
  signup: auth.signup,
  logout: auth.logout,
  whoami: auth.whoami,
  status: auth.whoami,
  use: auth.use,
  profiles: auth.profiles,
  track: data.track,
  decide: data.decide,
  label: data.label,
  decisions: data.decisions,
  entities: data.entities,
  "entity-types": data.entityTypes,
  actions: data.actions,
  sessions: data.sessions,
  workflows,
  models,
  queues: cases.queues,
  cases: cases.cases,
  stats: data.stats,
  usage: data.usageReport,
  workspaces: admin.workspaces,
  environments: admin.environments,
  keys: admin.keys,
  jobs: admin.jobs,
  import: importHistory,
};

/** Take the options that every command has out of the arguments, wherever they are. */
function globals(argv: string[]) {
  const rest: string[] = [];
  const out: { json: boolean; help: boolean; profile?: string; url?: string } = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    const [flag, inline] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    if (flag === "--json") out.json = true;
    else if (flag === "-h" || flag === "--help") out.help = true;
    else if (flag === "--profile" || flag === "--url") {
      const value = inline ?? argv[++i];
      if (!value) throw new CliError(`${flag} needs a value`);
      out[flag === "--profile" ? "profile" : "url"] = value;
    } else rest.push(arg);
  }
  return { ...out, rest };
}

async function main() {
  // `pnpm kairos` runs in the repository root; a file name must mean the one where it was typed.
  if (process.env.npm_lifecycle_event === "kairos" && process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);
  const { rest, help, ...options } = globals(process.argv.slice(2));
  const [name, ...args] = rest;
  if (!name || name === "help") {
    console.log(HELP);
    return;
  }
  const command = COMMANDS[name];
  if (!command) throw new CliError(`Unknown command "${name}". See "kairos --help".`);
  if (help && name === "import") {
    console.log(IMPORT_HELP);
    return;
  }
  if (help) {
    const lines = HELP.split("\n").filter((line) => line.trimStart().startsWith(`kairos ${name}`));
    console.log(lines.length ? lines.join("\n") : HELP);
    return;
  }

  const profile = profileName(options.profile);
  let client: Client | undefined;
  const stored = () => readConfig().profiles[profile] ?? {};
  const ctx: Context = {
    json: options.json,
    profile,
    url: options.url,
    stored,
    client: () => (client ??= new Client(connection(stored(), options.url))),
  };
  await command(args, ctx);
}

main().catch((cause) => {
  if (cause instanceof CliError) {
    console.error(`${red("error")} ${cause.message}`);
    process.exit(cause.exitCode);
  }
  console.error(cause);
  process.exit(1);
});
