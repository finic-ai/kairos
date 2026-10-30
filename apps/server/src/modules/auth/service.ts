import type { TenancyRepository } from "../../repositories";
import type { Environments } from "../environments/service";
import type { User } from "../../types";
import type { UsersService } from "../../services/user.service";

export async function profile(
  accounts: TenancyRepository,
  users: UsersService,
  environments: Environments,
  user: User,
) {
  return {
    user: { ...user, has_password: (await users.providerOf(user.id)) === "native" },
    workspaces: await Promise.all(
      (await accounts.workspacesOf(user.id)).map(async (workspace) => ({
        ...workspace,
        environments: await environments.list(workspace.id),
      })),
    ),
  };
}

export async function setUpNewUser(
  accounts: TenancyRepository,
  users: UsersService,
  user: User,
  now: Date,
): Promise<void> {
  if ((await users.count()) === 1) await accounts.adoptOrphans(user.id, now);
  if ((await accounts.workspacesOf(user.id)).length === 0)
    await accounts.createWorkspace(`${user.name}'s workspace`, user.id, now);
}
