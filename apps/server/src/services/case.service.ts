import type { Executor } from "../platform/database";
import { DatabaseService } from "../platform/orm";

type Scope = { workspaceId: string; environmentId: string };

export class CasesService extends DatabaseService<"cases"> {
  constructor(db: Executor, scope: Scope) {
    super(db, "cases", scope);
  }

  /** The case a trigger with this key can join in this queue, if there is one. */
  findJoinable(queueId: string, correlationKey: string) {
    return this.findFirst({ where: { queueId, correlationKey, joinable: true } });
  }

  /** The case with this key resolved most recently, since `since`: one that a trigger reopens. */
  findReopenable(queueId: string, correlationKey: string, since: Date) {
    return this.findFirst({
      where: { queueId, correlationKey, status: "resolved", resolvedAt: { gte: since } },
      orderBy: { resolvedAt: "desc" },
    });
  }

  async hasAny(queueId: string): Promise<boolean> {
    return (await this.count({ queueId })) > 0;
  }
}

export class CaseEvidenceService extends DatabaseService<"caseEvidence"> {
  constructor(db: Executor, scope: Scope) {
    super(db, "caseEvidence", scope);
  }

  findByKey(idempotencyKey: string) {
    return this.findFirst({ where: { idempotencyKey } });
  }

  listFor(caseId: string) {
    return this.findMany({ where: { caseId }, orderBy: { ts: "asc", created: "asc" } });
  }
}

export class CaseItemsService extends DatabaseService<"caseItems"> {
  constructor(db: Executor, scope: Scope) {
    super(db, "caseItems", scope);
  }

  listFor(caseId: string) {
    return this.findMany({ where: { caseId }, orderBy: { created: "asc", id: "asc" } });
  }
}

export class CaseActivityService extends DatabaseService<"caseActivity"> {
  constructor(db: Executor, scope: Scope) {
    super(db, "caseActivity", scope);
  }

  listFor(caseId: string) {
    return this.findMany({ where: { caseId }, orderBy: { created: "asc", id: "asc" } });
  }
}
