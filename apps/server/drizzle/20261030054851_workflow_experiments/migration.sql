CREATE TABLE "workflow_experiments" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"workflow" text NOT NULL,
	"base_version" integer,
	"status" text NOT NULL,
	"error" text,
	"config" json NOT NULL,
	"dataset" json,
	"results" json,
	"best" text,
	"selected" json,
	"applied" json,
	"created_by" text,
	"started" timestamp with time zone,
	"finished" timestamp with time zone,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "workflow_optimizations";--> statement-breakpoint
CREATE INDEX "workflow_experiments_by_workflow" ON "workflow_experiments" ("workspace_id","environment_id","workflow","created");--> statement-breakpoint
ALTER TABLE "workflow_experiments" ADD CONSTRAINT "workflow_experiments_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_experiments" ADD CONSTRAINT "workflow_experiments_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;