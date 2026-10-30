-- Every workspace id that data was stored under gets a workspace row, so that the foreign keys hold.
INSERT INTO "workspaces" ("id", "name", "created")
SELECT known.id, known.id, now() FROM (
  SELECT "project" AS id FROM "events"
  UNION SELECT "project" AS id FROM "event_entities"
  UNION SELECT "project" AS id FROM "objects"
  UNION SELECT "project" AS id FROM "labels"
  UNION SELECT "project" AS id FROM "entities"
  UNION SELECT "project" AS id FROM "actions"
  UNION SELECT "project" AS id FROM "dashboards"
  UNION SELECT "project" AS id FROM "decisions"
) known
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Rows left behind by a workspace or a person that was deleted.
DELETE FROM "memberships" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces") OR "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
DELETE FROM "invites" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");--> statement-breakpoint
DELETE FROM "api_keys" WHERE "workspace_id" NOT IN (SELECT "id" FROM "workspaces");--> statement-breakpoint
DELETE FROM "sessions" WHERE "user_id" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint
ALTER TABLE "events" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "event_entities" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "objects" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "labels" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "entities" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "actions" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "dashboards" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "decisions" RENAME COLUMN "project" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "events" RENAME CONSTRAINT "events_project_id_pk" TO "events_workspace_id_id_pk";--> statement-breakpoint
ALTER TABLE "event_entities" RENAME CONSTRAINT "event_entities_project_entity_type_entity_id_ts_event_id_pk" TO "event_entities_workspace_id_entity_type_entity_id_ts_event_id_pk";--> statement-breakpoint
ALTER TABLE "objects" RENAME CONSTRAINT "objects_project_type_id_pk" TO "objects_workspace_id_type_id_pk";--> statement-breakpoint
ALTER TABLE "labels" RENAME CONSTRAINT "labels_project_entity_type_entity_id_label_pk" TO "labels_workspace_id_entity_type_entity_id_label_pk";--> statement-breakpoint
ALTER TABLE "entities" RENAME CONSTRAINT "entities_project_type_pk" TO "entities_workspace_id_type_pk";--> statement-breakpoint
ALTER TABLE "actions" RENAME CONSTRAINT "actions_project_name_version_pk" TO "actions_workspace_id_name_version_pk";--> statement-breakpoint
ALTER TABLE "dashboards" RENAME CONSTRAINT "dashboards_project_id_pk" TO "dashboards_workspace_id_id_pk";--> statement-breakpoint
ALTER TABLE "decisions" RENAME CONSTRAINT "decisions_project_id_pk" TO "decisions_workspace_id_id_pk";--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
