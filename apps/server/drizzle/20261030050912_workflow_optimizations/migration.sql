CREATE TABLE "workflow_optimizations" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"workflow" text NOT NULL,
	"base_version" integer,
	"config" json NOT NULL,
	"dataset" json NOT NULL,
	"selection" json NOT NULL,
	"variants" json NOT NULL,
	"selected" text NOT NULL,
	"applied" json,
	"created_by" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "workflow_optimizations_by_workflow" ON "workflow_optimizations" ("workspace_id","environment_id","workflow","created");--> statement-breakpoint
ALTER TABLE "workflow_optimizations" ADD CONSTRAINT "workflow_optimizations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_optimizations" ADD CONSTRAINT "workflow_optimizations_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;