ALTER TABLE "api_keys" ALTER COLUMN "allowed_ips" SET DATA TYPE jsonb USING "allowed_ips"::jsonb;--> statement-breakpoint
ALTER TABLE "api_keys" ALTER COLUMN "allowed_origins" SET DATA TYPE jsonb USING "allowed_origins"::jsonb;--> statement-breakpoint
ALTER TABLE "dashboards" ALTER COLUMN "definition" SET DATA TYPE jsonb USING "definition"::jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ALTER COLUMN "decision" SET DATA TYPE jsonb USING "decision"::jsonb;--> statement-breakpoint
ALTER TABLE "labels" ALTER COLUMN "properties" SET DATA TYPE jsonb USING "properties"::jsonb;--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "set_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "set_at" SET DATA TYPE jsonb USING "set_at"::jsonb;--> statement-breakpoint
ALTER TABLE "objects" ALTER COLUMN "set_at" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "events_properties_gin" ON "events" USING gin (("properties"::jsonb));--> statement-breakpoint
CREATE INDEX "objects_properties_gin" ON "objects" USING gin ((lower("properties"::text)::jsonb));