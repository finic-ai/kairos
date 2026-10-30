import { createContext } from "react";
import type { Environment } from "../types/interfaces";
import type { Session, Workspace } from "../types/interfaces";

export interface WorkspaceState {
  session: Session;
  workspace: Workspace;
  environment: Environment;
  onChooseEnvironment: (id: string) => void;
  onChoose: (id: string) => void;
  onRefresh: () => Promise<void>;
  onSignOut: () => void;
  /** The session is over already: the account was deleted, or sign-out is done. */
  onSignedOut: () => void;
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null);
