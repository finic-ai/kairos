import { z } from "zod";
import { MCP_GROUPS } from "./types";

export const settingsBody = z
  .object({
    enabled: z.boolean(),
    groups: z.array(z.enum(MCP_GROUPS)).max(MCP_GROUPS.length),
  })
  .strict();
