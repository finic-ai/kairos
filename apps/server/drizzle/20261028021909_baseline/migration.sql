CREATE TABLE "api_keys" (
	"environment_id" text NOT NULL,
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"hint" text NOT NULL,
	"allowed_ips" jsonb NOT NULL,
	"allowed_origins" jsonb NOT NULL,
	"created_by" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used" timestamp with time zone,
	"revoked" timestamp with time zone,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_workspace_id" UNIQUE("workspace_id","id"),
	CONSTRAINT "environments_kind" CHECK ("kind" IN ('production', 'sandbox'))
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"accepted" timestamp with time zone,
	"revoked" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"permissions" jsonb DEFAULT '{}',
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "memberships_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"auth" jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"password_hash" text,
	"subject_id" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_entities" (
	"workspace_id" text,
	"environment_id" text,
	"entity_type" text,
	"entity_id" text,
	"ts" timestamp with time zone,
	"event_id" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_entities_scope_pk" PRIMARY KEY("workspace_id","environment_id","entity_type","entity_id","ts","event_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"entities" json NOT NULL,
	"properties" json NOT NULL,
	"universal_id" text,
	"status" text,
	"session_id" text,
	"via" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"label" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"properties" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"type" text NOT NULL,
	"external_id" text NOT NULL,
	"properties" json NOT NULL,
	"set_at" jsonb DEFAULT '{}' NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"definition" json NOT NULL,
	"display_name" text,
	"automatic" boolean DEFAULT false NOT NULL,
	"automatic_since" timestamp with time zone,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"owner" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "dashboards_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "definition_versions" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"definition" json NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"type" text NOT NULL,
	"definition" json NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"workflow_id" text,
	"workflow" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"trigger" jsonb NOT NULL,
	"definition" jsonb,
	"cursor" text,
	"segment" integer DEFAULT 0 NOT NULL,
	"steps" jsonb,
	"output" jsonb,
	"error" text,
	"test" boolean DEFAULT false NOT NULL,
	"parent_run_id" text,
	"depth" integer DEFAULT 0 NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"started" timestamp with time zone,
	"finished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"definition" json NOT NULL,
	"trigger_type" text NOT NULL,
	"display_name" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"failing_since" timestamp with time zone,
	"draft" json,
	"hook_token_hash" text,
	"hook_token_hint" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"decision" jsonb NOT NULL,
	"context" json NOT NULL,
	"raw" json NOT NULL,
	"event_id" text,
	"session_id" text,
	"request" json,
	"revision" integer DEFAULT 1 NOT NULL,
	"resolution" jsonb,
	"final_outcome" text GENERATED ALWAYS AS (COALESCE(resolution ->> 'outcome', decision ->> 'decision')) STORED,
	"automatic" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"webhook_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"type" text,
	"external_id" text,
	"subject_ref" text,
	"payload" json,
	"headers" jsonb,
	"problem" text,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt" timestamp with time zone,
	"response_status" integer,
	"response_body" text,
	"response_ms" integer,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"finished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"direction" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"disabled_reason" text,
	"secrets" jsonb NOT NULL,
	"token_hash" text,
	"token_hint" text,
	"url" text,
	"config" json NOT NULL,
	"failing_since" timestamp with time zone,
	"last_delivery" timestamp with time zone,
	"created_by" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"workspace_id" text,
	"environment_id" text,
	"group_key" text,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"finished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "case_activity" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"case_id" text NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_evidence" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"case_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"rule_id" text,
	"rule_version" integer,
	"snapshot" json NOT NULL,
	"correlation_key" text,
	"idempotency_key" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_items" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"case_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text,
	"ref_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_items_once" UNIQUE NULLS NOT DISTINCT("case_id","kind","ref_type","ref_id")
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"queue_id" text NOT NULL,
	"status" text NOT NULL,
	"priority" text NOT NULL,
	"assignee_id" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"correlation_key" text,
	"joinable" boolean DEFAULT true NOT NULL,
	"reason" text NOT NULL,
	"worst_outcome" text,
	"max_risk" integer,
	"evidence_count" integer DEFAULT 0 NOT NULL,
	"last_evidence_at" timestamp with time zone NOT NULL,
	"last_activity" timestamp with time zone NOT NULL,
	"resolution" jsonb,
	"resolved_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "queues" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "queues_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_by_workspace" ON "api_keys" ("workspace_id");--> statement-breakpoint
CREATE INDEX "api_keys_by_environment" ON "api_keys" ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_production" ON "environments" ("workspace_id") WHERE kind = 'production';--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name" ON "environments" ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token" ON "invites" ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_by_workspace" ON "invites" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user" ON "memberships" ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_by_user" ON "memberships" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token" ON "sessions" ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_by_user" ON "sessions" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email" ON "users" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_subject_id" ON "users" ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug" ON "workspaces" ("slug");--> statement-breakpoint
CREATE INDEX "event_entities_by_event" ON "event_entities" ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_external_id" ON "events" ("workspace_id","environment_id","external_id");--> statement-breakpoint
CREATE INDEX "events_by_time" ON "events" ("workspace_id","environment_id","ts");--> statement-breakpoint
CREATE INDEX "events_by_type" ON "events" ("workspace_id","environment_id","type","ts");--> statement-breakpoint
CREATE INDEX "events_by_universal_id" ON "events" ("workspace_id","environment_id","universal_id","ts");--> statement-breakpoint
CREATE INDEX "events_by_created" ON "events" ("workspace_id","environment_id","created");--> statement-breakpoint
CREATE INDEX "events_by_session" ON "events" ("workspace_id","environment_id","session_id","ts");--> statement-breakpoint
CREATE INDEX "events_properties_gin" ON "events" USING gin (("properties"::jsonb));--> statement-breakpoint
CREATE UNIQUE INDEX "labels_by_entity" ON "labels" ("workspace_id","environment_id","entity_type","entity_id","label");--> statement-breakpoint
CREATE INDEX "labels_by_time" ON "labels" ("workspace_id","environment_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "objects_external_id" ON "objects" ("workspace_id","environment_id","type","external_id");--> statement-breakpoint
CREATE INDEX "objects_properties_gin" ON "objects" USING gin ((lower("properties"::text)::jsonb));--> statement-breakpoint
CREATE UNIQUE INDEX "actions_name" ON "actions" ("workspace_id","environment_id","name");--> statement-breakpoint
CREATE INDEX "dashboards_by_environment" ON "dashboards" ("workspace_id","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "definition_versions_version" ON "definition_versions" ("workspace_id","environment_id","kind","name","version");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_type" ON "entities" ("workspace_id","environment_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_key" ON "workflow_runs" ("workspace_id","environment_id","workflow_id","key");--> statement-breakpoint
CREATE INDEX "workflow_runs_by_workflow" ON "workflow_runs" ("workspace_id","environment_id","workflow_id","created");--> statement-breakpoint
CREATE INDEX "workflow_runs_open" ON "workflow_runs" ("workspace_id","environment_id","status") WHERE status IN ('queued', 'running', 'waiting');--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_name" ON "workflows" ("workspace_id","environment_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_hook_token" ON "workflows" ("hook_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_one_per_action" ON "workflows" ("workspace_id","environment_id",("definition" -> 'trigger' ->> 'action')) WHERE trigger_type = 'decision' AND status = 'published';--> statement-breakpoint
CREATE INDEX "workflows_by_trigger" ON "workflows" ("workspace_id","environment_id","trigger_type");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_workflow_step" ON "decisions" ("workspace_id","environment_id",(metadata ->> 'workflow_step_key')) WHERE metadata ->> 'workflow_step_key' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "decisions_by_final_outcome" ON "decisions" ("workspace_id","environment_id","final_outcome","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_one_per_event" ON "decisions" ("event_id") WHERE event_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "decisions_by_time" ON "decisions" ("workspace_id","environment_id","ts");--> statement-breakpoint
CREATE INDEX "decisions_by_subject" ON "decisions" ("workspace_id","environment_id","subject_type","subject_id","ts");--> statement-breakpoint
CREATE INDEX "decisions_by_session" ON "decisions" ("workspace_id","environment_id","session_id","ts");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_log" ON "webhook_deliveries" ("workspace_id","environment_id","webhook_id","created");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_status" ON "webhook_deliveries" ("workspace_id","environment_id","webhook_id","status","created");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" ("next_attempt") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_subject" ON "webhook_deliveries" ("workspace_id","environment_id","subject_ref") WHERE subject_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_age" ON "webhook_deliveries" ("created");--> statement-breakpoint
CREATE INDEX "webhooks_by_workspace" ON "webhooks" ("workspace_id","environment_id","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_token" ON "webhooks" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_key" ON "jobs" ("kind","key");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" ("kind","run_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_by_scope" ON "jobs" ("workspace_id","environment_id","kind","status","created");--> statement-breakpoint
CREATE INDEX "jobs_by_group" ON "jobs" ("group_key") WHERE status IN ('pending', 'paused');--> statement-breakpoint
CREATE INDEX "jobs_by_age" ON "jobs" ("finished") WHERE status IN ('done', 'dead');--> statement-breakpoint
CREATE INDEX "case_activity_by_case" ON "case_activity" ("case_id","created");--> statement-breakpoint
CREATE UNIQUE INDEX "case_evidence_once" ON "case_evidence" ("workspace_id","environment_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "case_evidence_by_case" ON "case_evidence" ("case_id","ts");--> statement-breakpoint
CREATE INDEX "case_evidence_by_source" ON "case_evidence" ("workspace_id","environment_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "case_items_by_ref" ON "case_items" ("workspace_id","environment_id","kind","ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "cases_by_queue" ON "cases" ("workspace_id","environment_id","queue_id","status","created");--> statement-breakpoint
CREATE INDEX "cases_by_target" ON "cases" ("workspace_id","environment_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "cases_by_due" ON "cases" ("workspace_id","environment_id","queue_id","due_at") WHERE status <> 'resolved' AND due_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "cases_one_joinable_per_key" ON "cases" ("workspace_id","environment_id","queue_id","correlation_key") WHERE joinable AND correlation_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX "queues_by_environment" ON "queues" ("workspace_id","environment_id");--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_xC8TupyciDV8_fkey" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "definition_versions" ADD CONSTRAINT "definition_versions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "definition_versions" ADD CONSTRAINT "definition_versions_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "webhooks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_activity" ADD CONSTRAINT "case_activity_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_activity" ADD CONSTRAINT "case_activity_case_id_cases_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_activity" ADD CONSTRAINT "case_activity_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_evidence" ADD CONSTRAINT "case_evidence_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_evidence" ADD CONSTRAINT "case_evidence_case_id_cases_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_evidence" ADD CONSTRAINT "case_evidence_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_case_id_cases_id_fkey" FOREIGN KEY ("case_id") REFERENCES "cases"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "case_items" ADD CONSTRAINT "case_items_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_queue_id_queues_id_fkey" FOREIGN KEY ("queue_id") REFERENCES "queues"("id");--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
-- An id in the format of newId (src/platform/crypto.ts): a prefix, "_", and a ULID in lower-case
-- Crockford base32, with the time of `stamp`. For copies that run inside Postgres, such as the
-- sandbox copy, which make many rows without loading them into the server. Not monotonic: two ids
-- of one millisecond are in no order. All other code makes ids with newId.
CREATE FUNCTION kairos_id(prefix text, stamp timestamptz DEFAULT clock_timestamp()) RETURNS text
LANGUAGE plpgsql VOLATILE PARALLEL SAFE AS $$
DECLARE
  alphabet constant text := '0123456789abcdefghjkmnpqrstvwxyz';
  ms constant bigint := floor(extract(epoch FROM stamp) * 1000)::bigint;
  -- A version 4 UUID has no fixed bits in bytes 0 to 5 and 10 to 13: 80 random bits.
  bytes constant bytea := uuid_send(gen_random_uuid());
  high constant bigint := (get_byte(bytes, 0)::bigint << 32) | (get_byte(bytes, 1)::bigint << 24) | (get_byte(bytes, 2)::bigint << 16) | (get_byte(bytes, 3)::bigint << 8) | get_byte(bytes, 4);
  low constant bigint := (get_byte(bytes, 5)::bigint << 32) | (get_byte(bytes, 10)::bigint << 24) | (get_byte(bytes, 11)::bigint << 16) | (get_byte(bytes, 12)::bigint << 8) | get_byte(bytes, 13);
  ulid text := '';
BEGIN
  FOR i IN REVERSE 9..0 LOOP ulid := ulid || substr(alphabet, ((ms >> (5 * i)) & 31)::int + 1, 1); END LOOP;
  FOR i IN REVERSE 7..0 LOOP ulid := ulid || substr(alphabet, ((high >> (5 * i)) & 31)::int + 1, 1); END LOOP;
  FOR i IN REVERSE 7..0 LOOP ulid := ulid || substr(alphabet, ((low >> (5 * i)) & 31)::int + 1, 1); END LOOP;
  RETURN prefix || '_' || ulid;
END
$$;
