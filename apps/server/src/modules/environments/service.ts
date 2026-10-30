import { notFound, AppError } from "../../platform/error";
import type { Executor } from "../../platform/database";
import { EnvironmentsService } from "../../services/environment.service";
import { InvalidCopySelection, toEnvironment, type EnvironmentsRepository } from "./repo";
import type { CopyOptionsQuery, EnvironmentCopyOptions } from "./schema";
import type { Environment } from "./types";

const nameConflict = (cause: unknown) =>
  ((cause as { cause?: { code?: string } }).cause ?? (cause as { code?: string })).code === "23505";
const nameTaken = () => new AppError("conflict", "name_taken", "An environment with that name already exists");

export function createEnvironments({
  db,
  environments,
  now,
}: {
  db: Executor;
  environments: EnvironmentsRepository;
  now: () => Date;
}) {
  const environmentsIn = (workspaceId: string) => new EnvironmentsService(db, { workspaceId });

  async function environment(workspaceId: string, id: string | undefined, missing = "No such environment") {
    const found = await environmentsIn(workspaceId).findByIdOrProduction(id);
    if (!found) throw notFound(missing);
    return toEnvironment(found);
  }

  async function sandbox(workspaceId: string, id: string, change: string) {
    const target = await environment(workspaceId, id);
    if (target.kind === "production") throw new AppError("conflict", "production_protected", change);
    return target;
  }

  return {
    environment,
    sandbox,

    list: async (workspaceId: string) => (await environmentsIn(workspaceId).list()).map(toEnvironment),

    async copyOptions(workspaceId: string, sourceId: string, userId: string, query: CopyOptionsQuery) {
      const source = await environment(workspaceId, sourceId, "No such source environment");
      return environments.copyOptions(workspaceId, source.id, userId, query);
    },

    async createSandbox(
      workspaceId: string,
      input: { name: string; copy_from?: string; copy?: EnvironmentCopyOptions; copy_dashboards?: boolean },
      userId: string,
    ) {
      try {
        const created = await environments.createSandbox(workspaceId, input, userId, now());
        if (!created) throw notFound("No such source environment");
        return created;
      } catch (cause) {
        if (cause instanceof InvalidCopySelection)
          throw new AppError("invalid", "invalid_copy_selection", cause.message);
        if (nameConflict(cause)) throw nameTaken();
        throw cause;
      }
    },

    async renameSandbox(workspaceId: string, id: string, name: string) {
      try {
        const [renamed] = await environmentsIn(workspaceId).updateMany(
          { id, kind: "sandbox" },
          { name: name.trim() },
          now(),
        );
        if (!renamed) throw notFound("No such environment");
        return toEnvironment(renamed);
      } catch (cause) {
        if (nameConflict(cause)) throw nameTaken();
        throw cause;
      }
    },

    async deleteSandbox(workspaceId: string, target: Environment, confirm: string) {
      if (confirm.trim() !== target.name)
        throw new AppError("invalid", "not_confirmed", "Type the environment name to confirm");
      await environmentsIn(workspaceId).deleteMany({ id: target.id, kind: "sandbox" });
    },
  };
}

export type Environments = ReturnType<typeof createEnvironments>;
