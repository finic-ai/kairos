import type { Executor } from "../../platform/database";
import { clientsAdminRoutes, clientsRoutes, type ClientsDeps } from "./route";
import { createClients } from "./service";

export function clientsModule({ db, ...deps }: Omit<ClientsDeps, "clients"> & { db: Executor }) {
  const clients = createClients({ db, now: deps.now });
  return { clients, adminRoutes: clientsAdminRoutes({ ...deps, clients }), routes: clientsRoutes({ clients }) };
}
