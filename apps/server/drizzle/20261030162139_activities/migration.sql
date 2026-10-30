CREATE TABLE "activities" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text,
	"source" text NOT NULL,
	"user_id" text,
	"api_key_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"details" jsonb DEFAULT '{}' NOT NULL,
	"ip" text,
	"user_agent" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activities_by_workspace" ON "activities" ("workspace_id","created");--> statement-breakpoint
CREATE INDEX "activities_by_environment" ON "activities" ("workspace_id","environment_id","created");--> statement-breakpoint
CREATE INDEX "activities_by_user" ON "activities" ("workspace_id","user_id","created");--> statement-breakpoint
CREATE INDEX "activities_by_resource" ON "activities" ("workspace_id","resource_type","resource_id","created");--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;