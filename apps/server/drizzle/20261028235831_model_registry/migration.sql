CREATE TABLE "model_artifacts" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"sha256" text NOT NULL,
	"format" text NOT NULL,
	"file" bytea NOT NULL,
	"size" integer NOT NULL,
	"stored_size" integer NOT NULL,
	"samples" bytea NOT NULL,
	"sample_count" integer NOT NULL,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"definition" json NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_at" timestamp with time zone,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_artifacts_sha256" ON "model_artifacts" ("workspace_id","environment_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "models_slug" ON "models" ("workspace_id","environment_id","slug");--> statement-breakpoint
CREATE INDEX "models_by_kind" ON "models" ("workspace_id","environment_id","kind","status");--> statement-breakpoint
ALTER TABLE "model_artifacts" ADD CONSTRAINT "model_artifacts_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_artifacts" ADD CONSTRAINT "model_artifacts_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
-- The files are gzip already: Postgres keeps them out of line and does not try to compress them again.
ALTER TABLE "model_artifacts" ALTER COLUMN "file" SET STORAGE EXTERNAL;--> statement-breakpoint
ALTER TABLE "model_artifacts" ALTER COLUMN "samples" SET STORAGE EXTERNAL;
