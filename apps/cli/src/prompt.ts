import { createInterface } from "node:readline/promises";
import { CliError } from "./args";

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

export async function ask(question: string): Promise<string> {
  if (!interactive()) throw new CliError(`${question.replace(/[:?]\s*$/, "")} is needed. Give it as an option.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a password without showing it. Without a terminal, the first line of stdin is the password. */
export async function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    return text.split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return done();
        if (char === "\u0003") return done(new CliError("Stopped", 130));
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.on("data", onData);
  });
}

export async function choose<T>(question: string, items: T[], label: (item: T) => string): Promise<T> {
  items.forEach((item, i) => console.log(`  ${i + 1}. ${label(item)}`));
  for (;;) {
    const answer = await ask(`${question} [1-${items.length}]: `);
    const index = Number(answer) - 1;
    if (Number.isInteger(index) && items[index] !== undefined) return items[index]!;
  }
}
