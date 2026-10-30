ALTER TABLE "decisions" ADD COLUMN "automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "via" text;--> statement-breakpoint
-- Before one decision per event is enforced: where an event has more than one, the earliest keeps
-- the link and the later ones lose it. No decision is deleted.
UPDATE "decisions" d SET "event_id" = NULL
  WHERE d."event_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "decisions" e
     WHERE e."workspace_id" = d."workspace_id" AND e."event_id" = d."event_id"
       AND (e."ts" < d."ts" OR (e."ts" = d."ts" AND e."id" < d."id"))
  );--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_one_per_event" ON "decisions" USING btree ("workspace_id","event_id") WHERE event_id IS NOT NULL;