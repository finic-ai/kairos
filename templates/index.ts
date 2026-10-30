/**
 * Action templates: complete definitions used by the examples and the evaluation
 * suite. Each one is a JSON file in `actions/`, so it can be read from
 * any language or sent to the API as it is.
 *
 * A template is a starting point. Every one was written for synthetic data: copy
 * it, change the wording to your product, and set the thresholds on your own outcomes.
 * See docs/templates/overview.md.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActionDefinition } from "../packages/sdk/src/index.js";

export const TEMPLATES = [
  "withdrawal",
  "bank_transfer",
  "merchant_onboarding",
  "fraud_claim",
  "red_flag",
  "atm_withdrawal",
  "loan_application",
  "insurance_claim",
  "medical_claim",
  "push_payment",
  "ticket_purchase",
  "ecommerce_checkout",
] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** The definition of one template, ready for `kairos.defineAction(name, definition)`. */
export function template(name: TemplateName): ActionDefinition {
  const file = fileURLToPath(new URL(`./actions/${name}.json`, import.meta.url));
  const { name: _name, ...definition } = JSON.parse(readFileSync(file, "utf8"));
  return definition;
}
