const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const blue = paint(34);
export const magenta = paint(35);

const visible = (text: string) => text.replace(/\x1b\[\d+m/g, "").length;
const pad = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visible(text)));

export function outcome(value: unknown): string {
  const text = String(value ?? "-");
  if (text === "approve") return green(text);
  if (text === "block") return red(text);
  if (text === "review" || text === "step_up") return yellow(text);
  return text;
}

export function state(value: unknown): string {
  const text = String(value ?? "-");
  if (text === "done" || text === "published") return green(text);
  if (text === "failed" || text === "dead") return red(text);
  if (["queued", "running", "waiting", "pending", "draft"].includes(text)) return yellow(text);
  return dim(text);
}

export const when = (iso: unknown) => (typeof iso === "string" ? iso.replace("T", " ").replace(/\.\d+Z$|Z$/, "") : "-");

export const list = (values: unknown) => (Array.isArray(values) && values.length ? values.join(", ") : "-");

export type Column<T> = [header: string, value: (row: T) => unknown];

export function table<T>(rows: T[], columns: Column<T>[], empty = "Nothing found."): void {
  if (rows.length === 0) {
    console.log(dim(empty));
    return;
  }
  const cells = rows.map((row) =>
    columns.map(([, value]) => {
      const cell = value(row);
      return cell === undefined || cell === null ? "-" : String(cell);
    }),
  );
  const widths = columns.map(([header], i) => Math.max(header.length, ...cells.map((row) => visible(row[i]!))));
  console.log(
    bold(
      columns
        .map(([header], i) => pad(header, widths[i]!))
        .join("  ")
        .trimEnd(),
    ),
  );
  for (const row of cells)
    console.log(
      row
        .map((cell, i) => pad(cell, widths[i]!))
        .join("  ")
        .trimEnd(),
    );
}

export function fields(rows: [string, unknown][]): void {
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    const text = value === undefined || value === null || value === "" ? "-" : String(value);
    console.log(`${dim(pad(label, width))}  ${text}`);
  }
}

export const printJson = (data: unknown) => console.log(JSON.stringify(data, null, 2));

export function show(json: boolean, data: unknown, human: () => void): void {
  if (json) printJson(data);
  else human();
}

export function more(total: unknown, shown: number): void {
  if (typeof total === "number" && total > shown)
    console.log(dim(`${shown} of ${total}. Use --limit and --offset for more.`));
}
