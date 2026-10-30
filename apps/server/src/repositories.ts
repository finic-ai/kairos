import type { Executor } from "./platform/database";
import type { AnalyticsRepository, EntitiesRepository, EventsRepository, OutboxRepository } from "./types";
import { analyticsRepository } from "./modules/observe/repo";
import { entitiesRepository } from "./modules/catalog/repo";
import { eventsRepository } from "./modules/ingest/repo";
import { JobsService } from "./services/job.service";
import { outboxRepository } from "./modules/webhooks/repo";

export { tenancyRepository, type TenancyRepository } from "./modules/tenancy/repo";
export { environmentsRepository, type EnvironmentsRepository } from "./modules/environments/repo";
export { webhooksRepository, type WebhooksRepository } from "./modules/webhooks/repo";

/**
 * The repositories of the data API: the queries that join tables. A query of one table is in its
 * table service. A route or a service is given only the repositories it uses, never all of them.
 */
export interface Repositories {
  /** What these repositories run on: the database, or the transaction that `transaction` opened. For the table services. */
  db: Executor;
  events: EventsRepository;
  entities: EntitiesRepository;
  analytics: AnalyticsRepository;
  /** The outbound webhook deliveries of a change. Write them in the `transaction` of the change. */
  outbox: OutboxRepository;
  /** Background work that a change starts. Enqueue it in the `transaction` of the change. */
  jobs: JobsService;
  /** Run `work` in one database transaction, with every repository bound to it. A throw rolls all of it back. */
  transaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
}

export function createRepositories(db: Executor): Repositories {
  return {
    db,
    events: eventsRepository(db),
    entities: entitiesRepository(db),
    analytics: analyticsRepository(db),
    outbox: outboxRepository(db),
    jobs: new JobsService(db),
    // A repository that opens its own transaction inside this one gets a savepoint.
    transaction: (work) => db.transaction((tx) => work(createRepositories(tx))),
  };
}
