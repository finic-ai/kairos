import type { ActionDefinition } from "@kairos/core";

/** An action definition as the API takes it: the server gives it the next version number. */
export type ActionBody = Omit<ActionDefinition, "version" | "displayName" | "automatic" | "automaticSince">;
