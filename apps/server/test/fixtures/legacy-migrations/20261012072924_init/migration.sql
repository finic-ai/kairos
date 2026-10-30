CREATE TABLE "actions" (
	"project" text NOT NULL,
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"definition" json NOT NULL,
	"created" timestamp with time zone NOT NULL,
	CONSTRAINT "actions_project_name_version_pk" PRIMARY KEY("project","name","version")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"key_hash" text NOT NULL,
	"hint" text NOT NULL,
	"allowed_ips" json NOT NULL,
	"allowed_origins" json NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"created_by" text,
	"last_used" timestamp with time zone,
	"revoked" timestamp with time zone,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1)
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"project" text NOT NULL,
	"id" text NOT NULL,
	"definition" json NOT NULL,
	"owner" text,
	"created" timestamp with time zone NOT NULL,
	"updated" timestamp with time zone NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "dashboards_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	CONSTRAINT "dashboards_project_id_pk" PRIMARY KEY("project","id")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"project" text NOT NULL,
	"id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"decision" json NOT NULL,
	"context" json NOT NULL,
	"raw" json NOT NULL,
	"event_id" text,
	CONSTRAINT "decisions_project_id_pk" PRIMARY KEY("project","id")
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"project" text NOT NULL,
	"type" text NOT NULL,
	"definition" json NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"updated" timestamp with time zone NOT NULL,
	CONSTRAINT "entities_project_type_pk" PRIMARY KEY("project","type")
);
--> statement-breakpoint
CREATE TABLE "event_entities" (
	"project" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"event_id" text NOT NULL,
	CONSTRAINT "event_entities_project_entity_type_entity_id_ts_event_id_pk" PRIMARY KEY("project","entity_type","entity_id","ts","event_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"project" text NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"entities" json NOT NULL,
	"properties" json NOT NULL,
	"universal_id" text,
	"status" text,
	"received" timestamp with time zone,
	CONSTRAINT "events_project_id_pk" PRIMARY KEY("project","id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	"accepted" timestamp with time zone,
	"revoked" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"project" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"label" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"properties" json NOT NULL,
	CONSTRAINT "labels_project_entity_type_entity_id_label_pk" PRIMARY KEY("project","entity_type","entity_id","label")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "memberships_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"project" text NOT NULL,
	"type" text NOT NULL,
	"id" text NOT NULL,
	"properties" json NOT NULL,
	"set_at" json DEFAULT '{}'::json NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"updated" timestamp with time zone NOT NULL,
	CONSTRAINT "objects_project_type_id_pk" PRIMARY KEY("project","type","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created" timestamp with time zone NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"supabase_id" text,
	"created" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_by_workspace" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "decisions_by_time" ON "decisions" USING btree ("project","ts");--> statement-breakpoint
CREATE INDEX "decisions_by_subject" ON "decisions" USING btree ("project","subject_type","subject_id","ts");--> statement-breakpoint
CREATE INDEX "decisions_by_event" ON "decisions" USING btree ("project","event_id");--> statement-breakpoint
CREATE INDEX "event_entities_by_event" ON "event_entities" USING btree ("project","event_id");--> statement-breakpoint
CREATE INDEX "events_by_time" ON "events" USING btree ("project","ts");--> statement-breakpoint
CREATE INDEX "events_by_type" ON "events" USING btree ("project","type","ts");--> statement-breakpoint
CREATE INDEX "events_by_universal_id" ON "events" USING btree ("project","universal_id","ts");--> statement-breakpoint
CREATE INDEX "events_by_received" ON "events" USING btree ("project","received");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invites_by_workspace" ON "invites" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "labels_by_time" ON "labels" USING btree ("project","ts");--> statement-breakpoint
CREATE INDEX "memberships_by_user" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_by_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_supabase_id" ON "users" USING btree ("supabase_id");