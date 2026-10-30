import type { Repositories } from "../../../repositories";
import { hasIntakeFor } from "../repo";
import { CASE_EVALUATE_KIND } from "../types";

/**
 * Enqueue the test of a new decision against the intake rules of the queues, in the transaction
 * that saves the decision: a saved decision always has its test. A decision of an action that no
 * queue takes enqueues nothing, so it costs one indexed read. Returns whether a job was written.
 */
export async function enqueueCaseIntake(
  tx: Pick<Repositories, "db" | "jobs">,
  scope: { workspaceId: string; environmentId: string },
  decision: { id: string; action: string },
  now: Date,
): Promise<boolean> {
  const action = decision.action.split("@")[0]!;
  if (!(await hasIntakeFor(tx.db, scope, action))) return false;
  return tx.jobs.enqueue(
    {
      kind: CASE_EVALUATE_KIND,
      key: `${scope.environmentId}:${decision.id}`,
      payload: { decision_id: decision.id },
      workspaceId: scope.workspaceId,
      environmentId: scope.environmentId,
    },
    now,
  );
}
