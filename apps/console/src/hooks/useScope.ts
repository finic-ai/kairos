import { useContext } from "react";
import { ScopeContext, type Scope } from "../lib/scope";

export function useScope(): Scope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("useScope is used outside a ScopeProvider");
  return scope;
}
