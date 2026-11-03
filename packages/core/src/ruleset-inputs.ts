import type { RulesetInput, RulesetInputType } from "./rulesets";

export const INPUT_GROUPS = [
  "Transaction",
  "History",
  "Account",
  "Device and location",
  "Payee",
  "Identity",
  "Commerce",
  "Lending",
] as const;
export type InputGroup = (typeof INPUT_GROUPS)[number];

/** A standard input. The catalog only names it: the workflow or the caller gives its value. */
export interface CatalogInput {
  name: string;
  type: RulesetInputType;
  group: InputGroup;
  label: string;
  description: string;
}

const input = (
  group: InputGroup,
  name: string,
  type: RulesetInputType,
  label: string,
  description: string,
): CatalogInput => ({ name, type, group, label, description });

/** The inputs that the templates use, by the same names, so that one workflow's inputs fit more than one ruleset. */
export const INPUT_CATALOG: readonly CatalogInput[] = [
  input("Transaction", "amount", "number", "Amount", "The amount of the transaction"),
  input("Transaction", "uses_promo", "boolean", "Uses a promotion", "The order uses a promotion"),
  input("History", "count_1h", "number", "Transactions, 1 hour", "Transactions in the last hour"),
  input("History", "count_24h", "number", "Transactions, 24 hours", "Transactions in the last 24 hours"),
  input("History", "sum_24h", "number", "Amount, 24 hours", "The amount moved in the last 24 hours"),
  input("History", "money_in_24h", "number", "Money in, 24 hours", "Money received in the last 24 hours"),
  input(
    "History",
    "money_out_24h",
    "number",
    "Money out, 24 hours",
    "Money sent in the last 24 hours, with this transaction",
  ),
  input(
    "History",
    "near_limit_24h",
    "number",
    "Near the limit, 24 hours",
    "Transactions in the last 24 hours between 90% and 100% of a limit",
  ),
  input("History", "attempts_10m", "number", "Attempts, 10 minutes", "Payment attempts in the last 10 minutes"),
  input("History", "cards_10m", "number", "Cards, 10 minutes", "Different cards in the last 10 minutes"),
  input("Account", "account_age_days", "number", "Account age", "Days since the account was opened"),
  input(
    "Account",
    "days_since_last_activity",
    "number",
    "Days since last activity",
    "Days since the account's last activity",
  ),
  input("Account", "trusted", "boolean", "Trusted customer", "The customer has a history of good payments"),
  input(
    "Account",
    "password_reset_24h",
    "boolean",
    "Password reset, 24 hours",
    "The password was reset in the last 24 hours",
  ),
  input(
    "Account",
    "contact_changed_24h",
    "boolean",
    "Contact changed, 24 hours",
    "The email or the phone changed in the last 24 hours",
  ),
  input("Account", "failed_logins_1h", "number", "Failed sign-ins, 1 hour", "Failed sign-ins in the last hour"),
  input("Device and location", "new_device", "boolean", "New device", "The customer has not used this device before"),
  input(
    "Device and location",
    "accounts_on_device",
    "number",
    "Accounts on the device",
    "Accounts opened from the same device",
  ),
  input("Device and location", "ip_country", "text", "IP country", "The ISO country code of the IP address"),
  input("Device and location", "distance_km", "number", "Distance from last sign-in", "In km"),
  input(
    "Device and location",
    "hours_since_last_login",
    "number",
    "Hours since last sign-in",
    "Hours since the last sign-in",
  ),
  input("Payee", "new_payee", "boolean", "New payee", "The payee was added in the last 24 hours"),
  input("Payee", "payee_country", "text", "Payee country", "The ISO country code of the payee"),
  input("Identity", "country", "text", "Country", "The ISO country code that the customer gave"),
  input("Identity", "customer_age", "number", "Customer age", "The customer's age in years"),
  input("Identity", "email_domain", "text", "Email domain", "The part of the email after the @"),
  input("Identity", "name_match", "number", "Name match", "How well the name matches the document, from 0 to 1"),
  input("Identity", "document_country", "text", "Document country", "The ISO country code of the document"),
  input("Identity", "document_expired", "boolean", "Document expired", "The document is expired"),
  input("Identity", "nationality", "text", "Nationality", "The ISO country code of the nationality"),
  input("Identity", "residence", "text", "Residence", "The ISO country code of the residence"),
  input("Commerce", "billing_country", "text", "Billing country", "The ISO country code of the billing address"),
  input("Commerce", "shipping_country", "text", "Shipping country", "The ISO country code of the shipping address"),
  input(
    "Commerce",
    "promo_accounts_on_device",
    "number",
    "Promotion accounts on the device",
    "Other accounts on the device that used the promotion",
  ),
  input(
    "Commerce",
    "promo_accounts_on_card",
    "number",
    "Promotion accounts on the card",
    "Other accounts on the card that used the promotion",
  ),
  input("Commerce", "refunds_90d", "number", "Refunds, 90 days", "Refunds in the last 90 days"),
  input("Commerce", "orders_90d", "number", "Orders, 90 days", "Orders in the last 90 days"),
  input("Commerce", "chargebacks_180d", "number", "Chargebacks, 180 days", "Chargebacks in the last 180 days"),
  input("Lending", "requested_amount", "number", "Requested amount", "The amount of the loan"),
  input("Lending", "monthly_income", "number", "Monthly income", "The stated monthly income"),
  input(
    "Lending",
    "applications_7d",
    "number",
    "Applications, 7 days",
    "Credit applications in the last 7 days, from a bureau",
  ),
  input("Lending", "open_loans", "number", "Open loans", "Loans open now"),
];

export const catalogInput = (name: string) => INPUT_CATALOG.find((i) => i.name === name);

/** A catalog input as an input of a ruleset. */
export const fromCatalog = (i: CatalogInput): RulesetInput => ({
  name: i.name,
  type: i.type,
  label: i.label,
  description: i.description,
});
