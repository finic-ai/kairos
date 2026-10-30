import type { TenancyRepository } from "../../repositories";
import type { SessionsService } from "../../services/session.service";
import type { Executor } from "../../platform/database";
import type { Environments } from "../environments/service";
import { workspaceRoutes } from "./route";
import { createTenancy } from "./service";

export function tenancyModule({
  db,
  accounts,
  sessions,
  environmentService,
  now,
}: {
  db: Executor;
  accounts: TenancyRepository;
  sessions: SessionsService;
  environmentService: Environments;
  now: () => Date;
}) {
  const tenancy = createTenancy({ db, accounts, environments: environmentService, now });
  return {
    tenancy,
    routes: workspaceRoutes({ sessions, tenancy, now }),
  };
}
