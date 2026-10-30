import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { CliError, integer, parse } from "../args";
import type { Command } from "../context";
import { blue, bold, dim, magenta, yellow } from "../output";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function repository(): string {
  if (!existsSync(`${ROOT}apps/server/package.json`) || !existsSync(`${ROOT}apps/console/package.json`))
    throw new CliError("This command runs from a checkout of the Kairos repository, and none was found.");
  return ROOT;
}

interface Process {
  name: string;
  pkg: string;
  script: string;
  env?: Record<string, string | undefined>;
  color?: (text: string) => string;
}

/**
 * Run the processes until all of them stop, and stop all of them when one stops. Each one leads
 * a process group of its own, so that a signal reaches pnpm, tsx and the server under them: the
 * server must stop its embedded Postgres before it exits.
 */
async function supervise(processes: Process[]): Promise<never> {
  const cwd = repository();
  const prefixed = processes.length > 1;
  const width = Math.max(...processes.map((p) => p.name.length));
  const children: ChildProcess[] = [];
  let code = 0;
  let stopping = false;

  const signal = (child: ChildProcess, name: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      // It stopped in the meantime.
    }
  };
  const stopAll = (name: NodeJS.Signals) => {
    stopping = true;
    for (const child of children) signal(child, name);
  };
  process.on("SIGINT", () => stopAll("SIGINT"));
  process.on("SIGTERM", () => stopAll("SIGTERM"));

  const exited = processes.map((p) => {
    const child = spawn("pnpm", ["--silent", "--filter", p.pkg, "run", p.script], {
      cwd,
      env: {
        ...process.env,
        ...(prefixed && process.stdout.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: "1" } : {}),
        ...p.env,
      },
      // A process outside the terminal's group must not read the terminal, or it is stopped.
      stdio: ["ignore", prefixed ? "pipe" : "inherit", prefixed ? "pipe" : "inherit"],
      detached: process.platform !== "win32",
    });
    children.push(child);
    if (prefixed) {
      const label = (p.color ?? ((text: string) => text))(p.name.padEnd(width));
      for (const [stream, out] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ] as const) {
        if (stream)
          createInterface({ input: stream }).on("line", (line) => out.write(`${label} ${dim("│")} ${line}\n`));
      }
    }
    return new Promise<void>((resolve) => {
      child.on("error", (cause) => {
        console.error(`${p.name}: ${cause.message}. Is pnpm installed?`);
        code ||= 1;
        resolve();
      });
      child.on("exit", (exitCode, exitSignal) => {
        if (!stopping) {
          if (prefixed)
            console.error(yellow(`${p.name} stopped${exitCode ? ` with code ${exitCode}` : ""}; stopping the others.`));
          code ||= exitCode ?? 1;
          stopAll("SIGINT");
        } else if (exitCode && !exitSignal) code ||= exitCode;
        resolve();
      });
    });
  });
  await Promise.all(exited);
  process.exit(code);
}

const SERVER = "@kairos/server";
const CONSOLE = "@kairos/console";

function serverProcess(values: { port?: string; watch?: boolean; worker?: string }): Process {
  if (values.worker && values.worker !== "inline" && values.worker !== "separate")
    throw new CliError("--worker is inline or separate");
  return {
    name: "api",
    pkg: SERVER,
    script: values.watch ? "dev" : "start",
    env: { PORT: portOf(values.port), KAIROS_WORKER: values.worker },
    color: blue,
  };
}

function portOf(value: string | undefined): string | undefined {
  const port = integer(value, "--port");
  if (port !== undefined && (port < 1 || port > 65535)) throw new CliError("--port must be from 1 to 65535");
  return port === undefined ? undefined : String(port);
}

export const server: Command = async (args) => {
  const { values } = parse(args, {
    port: { type: "string", short: "p" },
    watch: { type: "boolean", short: "w" },
    worker: { type: "string" },
  });
  await supervise([serverProcess(values)]);
};

export const consoleApp: Command = async (args) => {
  const { values } = parse(args, {
    port: { type: "string", short: "p" },
    api: { type: "string" },
  });
  await supervise([
    {
      name: "console",
      pkg: CONSOLE,
      script: "dev",
      env: { CONSOLE_PORT: portOf(values.port), KAIROS_URL: values.api },
      color: magenta,
    },
  ]);
};

export const dev: Command = async (args) => {
  const { values } = parse(args, {
    port: { type: "string", short: "p" },
    "console-port": { type: "string" },
    watch: { type: "boolean", short: "w" },
    worker: { type: "boolean" },
  });
  // The console must know the port of the API, which can also come from the repository's .env.
  const port = portOf(values.port) ?? process.env.PORT ?? envFile().PORT ?? "8787";
  const api = serverProcess({ ...values, port, worker: values.worker ? "separate" : undefined });
  const consolePort = portOf(values["console-port"]) ?? "5273";
  console.log(
    `${bold("Kairos")} ${dim("·")} API on http://localhost:${port} ${dim("·")} console on http://localhost:${consolePort}\n`,
  );
  await supervise([
    api,
    ...(values.worker ? [{ name: "worker", pkg: SERVER, script: "worker", env: api.env, color: yellow }] : []),
    {
      name: "console",
      pkg: CONSOLE,
      script: "dev",
      env: { CONSOLE_PORT: consolePort, KAIROS_URL: `http://localhost:${port}` },
      color: magenta,
    },
  ]);
};

function envFile(): Record<string, string | undefined> {
  const path = `${repository()}.env`;
  if (!existsSync(path)) return {};
  return Object.fromEntries(Object.entries(parseEnv(readFileSync(path, "utf8"))).filter(([, value]) => value));
}

export const worker: Command = async (args) => {
  parse(args, {});
  await supervise([{ name: "worker", pkg: SERVER, script: "worker" }]);
};

export const migrate: Command = async (args) => {
  parse(args, {});
  await supervise([{ name: "migrate", pkg: SERVER, script: "db:migrate" }]);
};
