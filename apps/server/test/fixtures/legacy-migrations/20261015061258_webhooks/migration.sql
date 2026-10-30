CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
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
	"created" timestamp with time zone NOT NULL,
	"finished" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
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
	"created" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_log" ON "webhook_deliveries" USING btree ("workspace_id","webhook_id","created");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_status" ON "webhook_deliveries" USING btree ("workspace_id","webhook_id","status","created");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" USING btree ("next_attempt") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_subject" ON "webhook_deliveries" USING btree ("workspace_id","subject_ref") WHERE subject_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_by_age" ON "webhook_deliveries" USING btree ("created");--> statement-breakpoint
CREATE INDEX "webhooks_by_workspace" ON "webhooks" USING btree ("workspace_id","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_token" ON "webhooks" USING btree ("token_hash");