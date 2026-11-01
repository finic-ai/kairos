import type { z } from "zod";
import type { deployBody } from "./schema";

export type DeployInput = z.output<typeof deployBody>;

export interface Zone {
  id: string;
  name: string;
  account: { id: string; name: string };
}
