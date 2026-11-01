/** What a field of a form holds. */
export type InputKind = "password" | "card" | "account" | "otp" | "email" | "phone" | "other";

/** As much of a form field as its kind is read from. */
export interface Input {
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
}

/** What a field holds, read from what the page says about it: its type, autocomplete, name and id, never its value. */
export function inputKind(input: Input): InputKind {
  const hint = `${input.autocomplete ?? ""} ${input.name ?? ""} ${input.id ?? ""}`.toLowerCase();
  if (input.type === "password" || /password|passcode/.test(hint)) return "password";
  if (/cc-|card|cvc|cvv/.test(hint)) return "card";
  if (/one-time-code|otp|2fa|mfa/.test(hint)) return "otp";
  if (/iban|account|sort.?code|routing|swift|bic\b/.test(hint)) return "account";
  if (input.type === "email" || /email/.test(hint)) return "email";
  if (input.type === "tel" || /phone|mobile/.test(hint)) return "phone";
  return "other";
}

/** As much of a form as is read: what names it, and its fields. */
export interface FormLike {
  id?: unknown;
  name?: unknown;
  action?: string;
  elements?: ArrayLike<Input>;
}

const SENSITIVE = new Set<InputKind>(["password", "card", "account", "otp"]);

/**
 * What names a form and the kinds of its fields, for a form with a sensitive field: a sign-in,
 * a payment, a new payee. Nothing for any other, such as a search or a newsletter.
 */
export function sensitiveForm(form: FormLike): { form: string; fields: InputKind[] } | undefined {
  const kinds = new Set(Array.from(form.elements ?? [], inputKind));
  if (![...kinds].some((kind) => SENSITIVE.has(kind))) return undefined;
  return { form: formName(form), fields: [...kinds].filter((kind) => kind !== "other") };
}

// A field named "id" or "name" hides the form's own property behind the field, so each must be text.
function formName(form: FormLike): string {
  if (typeof form.id === "string" && form.id) return form.id;
  if (typeof form.name === "string" && form.name) return form.name;
  return form.action?.replace(/^[a-z][\w+.-]*:\/\/[^/]+/i, "").split("?")[0] ?? "";
}

/** How one form was filled in, from the first time it was touched to its submit. */
export class FormWatch {
  private readonly pasted = new Set<InputKind>();
  private pastes = 0;
  private keys = 0;
  private pointer = false;

  constructor(private readonly started: number) {}

  key(): void {
    this.keys++;
  }

  point(): void {
    this.pointer = true;
  }

  paste(kind: InputKind): void {
    this.pasted.add(kind);
    this.pastes++;
  }

  /** The properties of the form's event. `trusted` is false only for a submit event that a script dispatched itself. */
  summary(now: number, trusted: boolean): Record<string, unknown> {
    return {
      duration_ms: Math.max(0, now - this.started),
      pasted: [...this.pasted],
      paste_count: this.pastes,
      keys: this.keys,
      pointer: this.pointer,
      trusted,
    };
  }
}
