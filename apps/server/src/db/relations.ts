import { defineRelations, type RelationsBuilderColumnBase } from "drizzle-orm";
import * as schema from "./schema";

/**
 * The relations between the tables, for Drizzle's relational queries: `with` to load related rows,
 * and `where` to filter by them.
 *
 * Data is never read across environments. A relation between data tables names the workspace and
 * the environment in both `from` and `to`, unless it follows a Kairos id (`evt_…`), which is unique
 * on its own. A relation through a customer's id (an entity id, `external_id`) always names them.
 * A query still filters by `workspace_id` and `environment_id` itself: a relation does not scope.
 */
export const relations = defineRelations(schema, (r) => {
  const environmentOf = (t: { workspaceId: RelationsBuilderColumnBase; environmentId: RelationsBuilderColumnBase }) =>
    r.one.environments({
      from: [t.workspaceId, t.environmentId],
      to: [r.environments.workspaceId, r.environments.id],
      optional: false,
    });

  return {
    users: {
      memberships: r.many.memberships(),
      sessions: r.many.sessions(),
    },
    workspaces: {
      environments: r.many.environments(),
      memberships: r.many.memberships(),
      invites: r.many.invites(),
      apiKeys: r.many.apiKeys(),
    },
    environments: {
      workspace: r.one.workspaces({ from: r.environments.workspaceId, to: r.workspaces.id, optional: false }),
    },
    memberships: {
      workspace: r.one.workspaces({ from: r.memberships.workspaceId, to: r.workspaces.id, optional: false }),
      user: r.one.users({ from: r.memberships.userId, to: r.users.id, optional: false }),
    },
    invites: {
      workspace: r.one.workspaces({ from: r.invites.workspaceId, to: r.workspaces.id, optional: false }),
      inviter: r.one.users({ from: r.invites.invitedBy, to: r.users.id }),
    },
    sessions: {
      user: r.one.users({ from: r.sessions.userId, to: r.users.id, optional: false }),
    },
    apiKeys: {
      workspace: r.one.workspaces({ from: r.apiKeys.workspaceId, to: r.workspaces.id, optional: false }),
      environment: environmentOf(r.apiKeys),
    },

    events: {
      environment: environmentOf(r.events),
      // Named `links`: `entities` is a column, the entity type → id that the customer sent.
      links: r.many.eventEntities({ from: r.events.id, to: r.eventEntities.eventId }),
      decision: r.one.decisions({ from: r.events.id, to: r.decisions.eventId }),
    },
    eventEntities: {
      event: r.one.events({ from: r.eventEntities.eventId, to: r.events.id, optional: false }),
      // Only an entity with stored properties has an object.
      object: r.one.objects({
        from: [
          r.eventEntities.workspaceId,
          r.eventEntities.environmentId,
          r.eventEntities.entityType,
          r.eventEntities.entityId,
        ],
        to: [r.objects.workspaceId, r.objects.environmentId, r.objects.type, r.objects.externalId],
      }),
    },
    objects: {
      environment: environmentOf(r.objects),
      definition: r.one.entities({
        from: [r.objects.workspaceId, r.objects.environmentId, r.objects.type],
        to: [r.entities.workspaceId, r.entities.environmentId, r.entities.type],
      }),
      links: r.many.eventEntities({
        from: [r.objects.workspaceId, r.objects.environmentId, r.objects.type, r.objects.externalId],
        to: [
          r.eventEntities.workspaceId,
          r.eventEntities.environmentId,
          r.eventEntities.entityType,
          r.eventEntities.entityId,
        ],
      }),
      labels: r.many.labels({
        from: [r.objects.workspaceId, r.objects.environmentId, r.objects.type, r.objects.externalId],
        to: [r.labels.workspaceId, r.labels.environmentId, r.labels.entityType, r.labels.entityId],
      }),
      decisions: r.many.decisions({
        from: [r.objects.workspaceId, r.objects.environmentId, r.objects.type, r.objects.externalId],
        to: [r.decisions.workspaceId, r.decisions.environmentId, r.decisions.subjectType, r.decisions.subjectId],
      }),
    },
    labels: {
      environment: environmentOf(r.labels),
      object: r.one.objects({
        from: [r.labels.workspaceId, r.labels.environmentId, r.labels.entityType, r.labels.entityId],
        to: [r.objects.workspaceId, r.objects.environmentId, r.objects.type, r.objects.externalId],
      }),
    },

    entities: {
      environment: environmentOf(r.entities),
      objects: r.many.objects({
        from: [r.entities.workspaceId, r.entities.environmentId, r.entities.type],
        to: [r.objects.workspaceId, r.objects.environmentId, r.objects.type],
      }),
    },
    actions: {
      environment: environmentOf(r.actions),
    },
    definitionVersions: {
      environment: environmentOf(r.definitionVersions),
    },
    models: {
      environment: environmentOf(r.models),
    },
    modelArtifacts: {
      environment: environmentOf(r.modelArtifacts),
    },
    workflowExperiments: {
      environment: environmentOf(r.workflowExperiments),
    },
    rulesets: {
      environment: environmentOf(r.rulesets),
    },
    lists: {
      environment: environmentOf(r.lists),
    },
    workflows: {
      environment: environmentOf(r.workflows),
    },
    workflowRuns: {
      environment: environmentOf(r.workflowRuns),
    },
    dashboards: {
      environment: environmentOf(r.dashboards),
      // Named `ownedBy`: `owner` is the column. Null when an API key made it.
      ownedBy: r.one.users({ from: r.dashboards.owner, to: r.users.id }),
    },

    decisions: {
      environment: environmentOf(r.decisions),
      event: r.one.events({ from: r.decisions.eventId, to: r.events.id }),
      subject: r.one.objects({
        from: [r.decisions.workspaceId, r.decisions.environmentId, r.decisions.subjectType, r.decisions.subjectId],
        to: [r.objects.workspaceId, r.objects.environmentId, r.objects.type, r.objects.externalId],
      }),
    },

    queues: {
      environment: environmentOf(r.queues),
      ownedBy: r.one.users({ from: r.queues.owner, to: r.users.id }),
      cases: r.many.cases(),
    },
    cases: {
      environment: environmentOf(r.cases),
      queue: r.one.queues({ from: r.cases.queueId, to: r.queues.id, optional: false }),
      assignee: r.one.users({ from: r.cases.assigneeId, to: r.users.id }),
      evidence: r.many.caseEvidence(),
      items: r.many.caseItems(),
      activity: r.many.caseActivity(),
    },
    caseEvidence: {
      environment: environmentOf(r.caseEvidence),
      case: r.one.cases({ from: r.caseEvidence.caseId, to: r.cases.id, optional: false }),
    },
    caseItems: {
      environment: environmentOf(r.caseItems),
      case: r.one.cases({ from: r.caseItems.caseId, to: r.cases.id, optional: false }),
    },
    caseActivity: {
      environment: environmentOf(r.caseActivity),
      case: r.one.cases({ from: r.caseActivity.caseId, to: r.cases.id, optional: false }),
    },

    webhooks: {
      workspace: r.one.workspaces({ from: r.webhooks.workspaceId, to: r.workspaces.id, optional: false }),
      environment: environmentOf(r.webhooks),
      deliveries: r.many.webhookDeliveries(),
    },
    webhookDeliveries: {
      environment: environmentOf(r.webhookDeliveries),
      webhook: r.one.webhooks({ from: r.webhookDeliveries.webhookId, to: r.webhooks.id, optional: false }),
    },
    jobs: {
      workspace: r.one.workspaces({ from: r.jobs.workspaceId, to: r.workspaces.id }),
    },
    activities: {
      workspace: r.one.workspaces({ from: r.activities.workspaceId, to: r.workspaces.id, optional: false }),
      // Null once the person deletes their account: the activity stays.
      user: r.one.users({ from: r.activities.userId, to: r.users.id }),
    },
  };
});
