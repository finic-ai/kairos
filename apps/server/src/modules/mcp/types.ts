/**
 * The tools an agent gets come in groups, so an admin can give reads without writes.
 * `decide` calls the model or closes work, so it costs money or ends a review. `build` changes what
 * Kairos does: actions, entity types and workflows.
 */
export const MCP_GROUPS = ["read", "write", "decide", "build"] as const;
export type McpGroup = (typeof MCP_GROUPS)[number];

export interface McpSettings {
  enabled: boolean;
  groups: McpGroup[];
}

export const DEFAULT_MCP_SETTINGS: McpSettings = { enabled: true, groups: ["read"] };

export interface McpToolInfo {
  name: string;
  title: string;
  group: McpGroup;
  description: string;
  read_only: boolean;
  destructive: boolean;
}

export interface McpSettingsView extends McpSettings {
  tools: McpToolInfo[];
}
