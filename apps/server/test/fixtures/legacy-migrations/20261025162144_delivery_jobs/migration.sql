-- Outbound deliveries are sent by jobs now (internal/designs/jobs.md, section 6.1).
-- Each delivery that is still waiting gets its job: due when its next attempt was, with the
-- attempts it has made, and paused while its endpoint is disabled.
INSERT INTO "jobs" ("id", "kind", "key", "workspace_id", "environment_id", "group_key", "payload", "status", "run_at", "attempts", "created", "updated")
SELECT 'job_' || replace(gen_random_uuid()::text, '-', ''), 'webhook.deliver', d.id, d.workspace_id, d.environment_id, d.webhook_id,
       jsonb_build_object('delivery_id', d.id), CASE WHEN w.enabled THEN 'pending' ELSE 'paused' END,
       COALESCE(d.next_attempt, now()), d.attempts, d.created, now()
FROM "webhook_deliveries" d JOIN "webhooks" w ON w.id = d.webhook_id
WHERE d.direction = 'out' AND d.status = 'pending' AND d.next_attempt IS NOT NULL
ON CONFLICT ("kind", "key") DO NOTHING;
