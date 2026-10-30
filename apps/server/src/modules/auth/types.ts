export interface User {
  id: string;
  email: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  created: string;
}

export type Auth =
  { provider: "native"; strategy: "email_password" } | { provider: "supabase" | "cognito"; strategy?: Strategy };

/** How a person signs in at an outside provider, when it says. */
export type Strategy = "email_password" | "google";

export type Provider = Auth["provider"];
