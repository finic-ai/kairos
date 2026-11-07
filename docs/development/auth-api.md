# Sign-in endpoints

The `/auth` routes that the console and the CLI use to sign in. They are not part of the public API reference. They set and read the session cookie `kairos_session`: `HttpOnly`, `SameSite=Lax`, 30 days.

| | |
|---|---|
| `GET /auth/config` | No session needed. `{ password, signup, supabase }`: whether an account can be created without an invite, and the Supabase settings when that sign-in is on. |
| `POST /auth/signup` | `{ email, password, name?, invite? }`. The password has at least 8 characters and at most 72 bytes. Sets the session cookie. A new account gets a workspace of its own, or joins the workspace of its invite. The first account on a server becomes the owner of any workspace that has no members. |
| `POST /auth/login` | `{ email, password }`. Sets the session cookie. 400 for an empty password or one over 72 bytes, which no account can have. See the limits below. |
| `POST /auth/supabase` | `{ access_token, invite? }`. Only when Supabase sign-in is configured. |
| `POST /auth/logout` | Ends the session. |
| `GET /auth/me` | `{ user: { id, email, name, first_name, last_name, display_name, created, has_password }, workspaces: [{ id, name, slug, status, created, role, environments }] }`. |
| `PATCH /auth/me` | `{ name }`. |
| `POST /auth/password` | `{ current, password }`. Ends the person's other sessions. |
| `DELETE /auth/me` | `{ password }`, or `{ confirm: <email> }` for an account with no password. Deletes the account and each workspace that only this person is in. Refused with `sole_owner` while the person is the only owner of a workspace with other members. |
| `GET /auth/invites/:token` | No session needed. What an invite is for: `{ email, role, workspace_name, has_account }`. |
| `POST /auth/invites/:token/accept` | Join the workspace. The invite is for one email address. |

## Limits

A request over a limit gets 429 `rate_limited`, with `Retry-After` in seconds. Each window starts at the first request in it.

| Endpoint | Limit |
|---|---|
| `POST /auth/login` | In 15 minutes: 10 for one email address from one IP address, 100 for one email address, and 100 from one IP address. A sign-in that works does not count. |
| `POST /auth/signup` | 20 from one IP address in an hour. |
| `POST /auth/password`, `DELETE /auth/me` | 10 password checks for one person in 15 minutes. |

The IP address is the connection's address, or the first `X-Forwarded-For` address when `KAIROS_TRUST_PROXY` is on.
