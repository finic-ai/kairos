ALTER TABLE "decisions" ADD COLUMN "request" json;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "resolution" jsonb;--> statement-breakpoint
ALTER TABLE "decisions" ADD COLUMN "final_outcome" text GENERATED ALWAYS AS (COALESCE(resolution ->> 'outcome', decision ->> 'decision')) STORED;--> statement-breakpoint
CREATE INDEX "decisions_by_final_outcome" ON "decisions" USING btree ("workspace_id","final_outcome","ts");