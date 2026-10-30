import { useContext } from "react";
import { WorkspaceContext, type WorkspaceState } from "../lib/workspace";

export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext);
  if (!state) throw new Error("useWorkspace is used outside the signed-in app");
  return state;
}
