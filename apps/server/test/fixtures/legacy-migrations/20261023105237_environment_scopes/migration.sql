-- Add environments alongside the existing workspace scope.
-- Populate existing rows before enforcing the new keys and constraints.
CREATE TABLE "environments" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created" timestamp with time zone NOT NULL,
	CONSTRAINT "environments_kind" CHECK ("environments"."kind" IN ('production', 'sandbox'))
);--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_production" ON "environments" USING btree ("workspace_id") WHERE kind = 'production';--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name" ON "environments" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "environments_workspace_id" ON "environments" USING btree ("workspace_id","id");--> statement-breakpoint
-- Every existing workspace gets a production environment. Existing workspace IDs stay intact.
INSERT INTO "environments" ("id", "workspace_id", "name", "kind", "created")
SELECT 'env_' || replace(gen_random_uuid()::text, '-', ''), id, 'Production', 'production', created FROM "workspaces";--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "actions" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "actions" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "api_keys" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "dashboards" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "dashboards" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "decisions" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "entities" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "entities" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "entities" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "event_entities" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "event_entities" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "event_entities" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "events" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "labels" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "objects" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "webhook_deliveries" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "environment_id" text;--> statement-breakpoint
UPDATE "webhooks" AS data SET "environment_id" = env.id FROM "environments" AS env WHERE env.workspace_id = data.workspace_id AND env.kind = 'production';--> statement-breakpoint
ALTER TABLE "webhooks" ALTER COLUMN "environment_id" SET NOT NULL;--> statement-breakpoint
DROP INDEX "decisions_by_final_outcome";--> statement-breakpoint
DROP INDEX "decisions_one_per_event";--> statement-breakpoint
DROP INDEX "decisions_by_time";--> statement-breakpoint
DROP INDEX "decisions_by_subject";--> statement-breakpoint
DROP INDEX "decisions_by_event";--> statement-breakpoint
DROP INDEX "decisions_by_session";--> statement-breakpoint
DROP INDEX "event_entities_by_event";--> statement-breakpoint
DROP INDEX "events_by_time";--> statement-breakpoint
DROP INDEX "events_by_type";--> statement-breakpoint
DROP INDEX "events_by_universal_id";--> statement-breakpoint
DROP INDEX "events_by_received";--> statement-breakpoint
DROP INDEX "events_by_session";--> statement-breakpoint
DROP INDEX "labels_by_time";--> statement-breakpoint
DROP INDEX "webhook_deliveries_log";--> statement-breakpoint
DROP INDEX "webhook_deliveries_by_status";--> statement-breakpoint
DROP INDEX "webhook_deliveries_by_subject";--> statement-breakpoint
DROP INDEX "webhooks_by_workspace";--> statement-breakpoint
ALTER TABLE "actions" DROP CONSTRAINT "actions_workspace_id_name_version_pk";--> statement-breakpoint
ALTER TABLE "dashboards" DROP CONSTRAINT "dashboards_workspace_id_id_pk";--> statement-breakpoint
ALTER TABLE "decisions" DROP CONSTRAINT "decisions_workspace_id_id_pk";--> statement-breakpoint
ALTER TABLE "entities" DROP CONSTRAINT "entities_workspace_id_type_pk";--> statement-breakpoint
ALTER TABLE "event_entities" DROP CONSTRAINT "event_entities_workspace_id_entity_type_entity_id_ts_event_id_pk";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_workspace_id_id_pk";--> statement-breakpoint
ALTER TABLE "labels" DROP CONSTRAINT "labels_workspace_id_entity_type_entity_id_label_pk";--> statement-breakpoint
ALTER TABLE "objects" DROP CONSTRAINT "objects_workspace_id_type_id_pk";--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_workspace_id_environment_id_name_version_pk" PRIMARY KEY("workspace_id","environment_id","name","version");--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_environment_id_id_pk" PRIMARY KEY("workspace_id","environment_id","id");--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workspace_id_environment_id_id_pk" PRIMARY KEY("workspace_id","environment_id","id");--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_environment_id_type_pk" PRIMARY KEY("workspace_id","environment_id","type");--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_scope_pk" PRIMARY KEY("workspace_id","environment_id","entity_type","entity_id","ts","event_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_environment_id_id_pk" PRIMARY KEY("workspace_id","environment_id","id");--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_environment_id_entity_type_entity_id_label_pk" PRIMARY KEY("workspace_id","environment_id","entity_type","entity_id","label");--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_workspace_id_environment_id_type_id_pk" PRIMARY KEY("workspace_id","environment_id","type","id");--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_environment_id_environments_workspace_id_id_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_by_environment" ON "api_keys" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "decisions_by_final_outcome" ON "decisions" USING btree ("workspace_id","environment_id","final_outcome","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_one_per_event" ON "decisions" USING btree ("workspace_id","environment_id","event_id") WHERE event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "decisions_by_time" ON "decisions" USING btree ("workspace_id","environment_id","ts");--> statement-breakpoint
CREATE INDEX "decisions_by_subject" ON "decisions" USING btree ("workspace_id","environment_id","subject_type","subject_id","ts");--> statement-breakpoint
CREATE INDEX "decisions_by_event" ON "decisions" USING btree ("workspace_id","environment_id","event_id");--> statement-breakpoint
CREATE INDEX "decisions_by_session" ON "decisions" USING btree ("workspace_id","environment_id","session_id","ts");--> statement-breakpoint
CREATE INDEX "event_entities_by_event" ON "event_entities" USING btree ("workspace_id","environment_id","event_id");--> statement-breakpoint
CREATE INDEX "events_by_time" ON "events" USING btree ("workspace_id","environment_id","ts");--> statement-breakpoint
CREATE INDEX "events_by_type" ON "events" USING btree ("workspace_id","environment_id","type","ts");--> statement-breakpoint
CREATE INDEX "events_by_universal_id" ON "events" USING btree ("workspace_id","environment_id","universal_id","ts");--> statement-breakpoint
CREATE INDEX "events_by_received" ON "events" USING btree ("workspace_id","environment_id","received");--> statement-breakpoint
CREATE INDEX "events_by_session" ON "events" USING btree ("workspace_id","environment_id","session_id","ts");--> statement-breakpoint
CREATE INDEX "labels_by_time" ON "labels" USING btree ("workspace_id","environment_id","ts");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_log" ON "webhook_deliveries" USING btree ("workspace_id","environment_id","webhook_id","created");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_status" ON "webhook_deliveries" USING btree ("workspace_id","environment_id","webhook_id","status","created");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_subject" ON "webhook_deliveries" USING btree ("workspace_id","environment_id","subject_ref") WHERE subject_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhooks_by_workspace" ON "webhooks" USING btree ("workspace_id","environment_id","direction");
