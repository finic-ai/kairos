import { text, timestamp } from "drizzle-orm/pg-core";

export const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
/**
 * When Kairos wrote the row, and when the row last changed. The code sets both from the clock
 * that the service gives it, so that a test's fixed clock holds; the default is only a safety net.
 * A table whose rows never change has no `updated`. A write that only records activity
 * (`last_used`, `last_delivery`, `failing_since`) leaves `updated` as it is.
 */
export const created = () => time("created").notNull().defaultNow();
export const updated = () => time("updated").notNull().defaultNow();
export const environment = () => text("environment_id").notNull();
