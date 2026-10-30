CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
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
	"created" timestamp with time zone NOT NULL,
	"updated" timestamp with time zone NOT NULL,
	"finished" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "public"."environments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_kind_key" ON "jobs" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("kind","run_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_by_scope" ON "jobs" USING btree ("workspace_id","environment_id","kind","status","created");--> statement-breakpoint
CREATE INDEX "jobs_by_group" ON "jobs" USING btree ("group_key") WHERE status IN ('pending', 'paused');--> statement-breakpoint
CREATE INDEX "jobs_by_age" ON "jobs" USING btree ("finished") WHERE status IN ('done', 'dead');