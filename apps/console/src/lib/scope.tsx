import { createContext, useMemo, ReactNode } from "react";
import { setEnvironment, setWorkspace } from "../api/index";

export interface Scope {
  workspaceId: string;
  environmentId: string;
}

export const ScopeContext = createContext<Scope | null>(null);

export function ScopeProvider({ workspaceId, environmentId, children }: Scope & { children: ReactNode }) {
  // Requests that the children make while they render carry these headers already.
  setWorkspace(workspaceId);
  setEnvironment(environmentId);
  const scope = useMemo(() => ({ workspaceId, environmentId }), [workspaceId, environmentId]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}
