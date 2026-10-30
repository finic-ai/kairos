ALTER TABLE "decisions" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "decisions_by_session" ON "decisions" USING btree ("workspace_id","session_id","ts");--> statement-breakpoint
CREATE INDEX "events_by_session" ON "events" USING btree ("workspace_id","session_id","ts");