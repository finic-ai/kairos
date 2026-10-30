import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateMapping, type WebhookMapping } from "@kairos/core";
import { verificationProblem, signs, type Verification } from "./verify";

export const PRESET_CATEGORIES = [
  "device_intelligence",
  "payments",
  "customer_support",
  "transaction_intelligence",
  "commerce",
  "identity_verification",
] as const;

export interface WebhookPreset {
  provider: string;
  version: number;
  displayName: string;
  category: (typeof PRESET_CATEGORIES)[number];
  /**
   * Whether a real delivery from the provider has gone through this preset. Until one has, the
   * mapping is written from the provider's documentation only, and the console says so.
   */
  checked: boolean;
  description: string;
  verification: Verification;
  secretHint?: string;
  setup: string[];
  identity?: string;
  events: string[];
  mapping: WebhookMapping;
  samples: unknown[];
  /** The request headers of each sample, in the same order, for a provider that sends the topic or the id in a header. */
  sampleHeaders?: Record<string, string>[];
}

export function loadPresets(dir: string): WebhookPreset[] {
  const folder = join(dir, "webhooks");
  try {
    return readdirSync(folder)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => JSON.parse(readFileSync(join(folder, file), "utf8")) as WebhookPreset)
      .filter((p) => PRESET_CATEGORIES.includes(p.category) && typeof p.checked === "boolean")
      .filter(
        (p) =>
          !verificationProblem(p.verification) &&
          validateMapping(p.mapping, { allowSet: signs(p.verification) }).length === 0,
      );
  } catch {
    return [];
  }
}
