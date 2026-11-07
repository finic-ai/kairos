import type { Executor } from "../../platform/database";
import type { ModuleJobs } from "../../platform/jobs/worker";
import { RateLimitsService } from "../../services/rate_limit.service";
import { purgeWorkspace, workspacesWithRetention } from "./repo";
import type { Purged } from "./types";

/** Each hour. A run stops after RUN_BUDGET_MS; what is left waits for the next one. */
export const RETENTION_SCHEDULE = { kind: "retention.cleanup", everyMs: 3_600_000 };
const RUN_BUDGET_MS = 20_000;

/**
 * In each workspace with a retention period (settings.data_retention_days), delete the history
 * older than it, in every environment. Without one (the default), nothing is deleted.
 */
export async function runRetention(
  db: Executor,
  now: Date,
  budgetMs = RUN_BUDGET_MS,
): Promise<{ workspace: string; purged: Purged }[]> {
  const deadline = Date.now() + budgetMs;
  const done: { workspace: string; purged: Purged }[] = [];
  const all = (await workspacesWithRetention(db)).filter(({ days }) => Number.isInteger(days) && days >= 1);
  // Each workspace gets an equal share of what is left, and the first one changes each hour, so a
  // workspace with a large backlog cannot use every run.
  const start = all.length ? Math.floor(now.getTime() / 3_600_000) % all.length : 0;
  const turn = [...all.slice(start), ...all.slice(0, start)];
  for (const [i, { id, days }] of turn.entries()) {
    const share = Date.now() + (deadline - Date.now()) / (turn.length - i);
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    done.push({ workspace: id, purged: await purgeWorkspace(db, id, cutoff, share) });
    if (Date.now() > deadline) break;
  }
  return done;
}

export function retentionJobs({ db, now }: { db: Executor; now: () => Date }): ModuleJobs {
  return {
    kinds: [
      {
        kind: RETENTION_SCHEDULE.kind,
        concurrency: 1,
        retryDelaysMs: [5 * 60_000],
        timeoutMs: 30_000,
        async run() {
          await RateLimitsService.purgeExpired(db, now());
          await runRetention(db, now());
        },
      },
    ],
    schedules: [RETENTION_SCHEDULE],
  };
}
