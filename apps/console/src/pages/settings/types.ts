import type { Environment, Session, Workspace } from "../../types/interfaces";

export interface SettingsPageProps {
  environment: Environment;
  onChooseEnvironment: (id: string) => void;
  workspace: Workspace;
  session: Session;
  /** Called when the person, the list of workspaces or a name changed. */
  onChange: () => void;
  /** Called when the session is over: sign-out, or the account is deleted. */
  onSignedOut: () => void;
}
