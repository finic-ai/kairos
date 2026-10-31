import type { Executor } from "../../platform/database";
import { WorkspacesService } from "../../services/workspace.service";
import { storedClientSettings } from "./schema";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings, type ClientSettingsInput } from "./types";

const KEY = "clients";

export function createClients({ db, now }: { db: Executor; now: () => Date }) {
  const workspaces = new WorkspacesService(db);

  return {
    async settings(workspaceId: string, environmentId: string): Promise<ClientSettings> {
      const saved = storedClientSettings.safeParse(
        await workspaces.environmentSetting(workspaceId, KEY, environmentId),
      );
      return saved.success ? saved.data : DEFAULT_CLIENT_SETTINGS;
    },

    async save(workspaceId: string, environmentId: string, input: ClientSettingsInput): Promise<ClientSettings> {
      const version = await workspaces.saveEnvironmentSetting(workspaceId, KEY, environmentId, input, now());
      return { ...input, version };
    },
  };
}

export type Clients = ReturnType<typeof createClients>;
