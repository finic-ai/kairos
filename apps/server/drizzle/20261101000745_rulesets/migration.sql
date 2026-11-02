CREATE TABLE "lists" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"match" text DEFAULT 'exact' NOT NULL,
	"case_sensitive" boolean DEFAULT false NOT NULL,
	"items" jsonb DEFAULT '[]' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rulesets" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"settings" jsonb DEFAULT '{}' NOT NULL,
	"version" integer NOT NULL,
	"definition" json NOT NULL,
	"draft" json,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" text,
	"updated_by" text,
	"created" timestamp with time zone DEFAULT now() NOT NULL,
	"updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lists_slug" ON "lists" ("workspace_id","environment_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "rulesets_slug" ON "rulesets" ("workspace_id","environment_id","slug");--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "rulesets" ADD CONSTRAINT "rulesets_environment_fk" FOREIGN KEY ("workspace_id","environment_id") REFERENCES "environments"("workspace_id","id") ON DELETE CASCADE;