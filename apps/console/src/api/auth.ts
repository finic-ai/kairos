import { request, type ApiError } from "./client";
import type { AuthConfig, InviteInfo, MfaStatus, Session } from "../types/interfaces";

export const auth = {
  config: () => request<AuthConfig>("GET", "/auth/config"),
  me: () => request<Session>("GET", "/auth/me").catch((e: ApiError) => (e.status === 401 ? null : Promise.reject(e))),
  login: (email: string, password: string) => request<Session>("POST", "/auth/login", { email, password }),
  signup: (input: { email: string; password: string; name: string; invite?: string }) =>
    request<Session>("POST", "/auth/signup", input),
  supabase: (access_token: string, invite?: string) =>
    request<Session>("POST", "/auth/supabase", { access_token, invite }),
  // With Cognito, the server also names Cognito's sign-out page, which comes back to the console.
  logout: () =>
    request<{ redirect?: string }>("POST", "/auth/logout").then((r) => {
      if (r?.redirect) window.location.assign(r.redirect);
      return r;
    }),
  rename: (name: string) => request<Session>("PATCH", "/auth/me", { name }),
  deleteAccount: (input: { password?: string; confirm?: string }) => request<unknown>("DELETE", "/auth/me", input),
  password: (current: string, password: string) =>
    request<{ sessions_ended: number }>("POST", "/auth/password", { current, password }),
  mfa: () => request<MfaStatus>("GET", "/auth/mfa"),
  mfaSetup: () => request<{ secret: string; otpauth_uri: string }>("POST", "/auth/mfa/setup"),
  mfaVerify: (code: string) => request<{ enabled: boolean }>("POST", "/auth/mfa/verify", { code }),
  mfaDisable: () => request<{ enabled: boolean }>("POST", "/auth/mfa/disable"),
  invite: (token: string) => request<InviteInfo>("GET", `/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string) =>
    request<Session & { workspace_id: string }>("POST", `/auth/invites/${encodeURIComponent(token)}/accept`),
};
