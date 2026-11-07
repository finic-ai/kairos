CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY,
	"resource" text NOT NULL,
	"ip" inet,
	"hits" bigint NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limits_by_expiry" ON "rate_limits" ("expires");--> statement-breakpoint
CREATE INDEX "rate_limits_by_resource" ON "rate_limits" ("resource");--> statement-breakpoint
CREATE INDEX "rate_limits_by_ip" ON "rate_limits" ("ip");