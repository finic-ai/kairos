import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActionDefinition } from "@kairos/core";

/** The action the evaluation suite runs: the published `withdrawal` template, read from its one file. */
export const WITHDRAWAL_ACTION: ActionDefinition = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../templates/actions/withdrawal.json", import.meta.url)), "utf8"),
);
