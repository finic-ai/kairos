# Sign-in endpoints

The `/auth` routes that the console and the CLI use to sign in. They are not part of the public API reference. They set and read the session cookie `kairos_session`: `HttpOnly`, `SameSite=Lax`, 30 days.

| | |
|---|---|
| `GET /auth/config` | No session needed. `{ password, signup, supabase }`: whether an account can be created without an invite, and the Supabase settings when that sign-in is on. |
| `POST /auth/signup` | `{ email, password, name?, invite? }`. The password has at least 8 characters and at most 72 bytes. Sets the session cookie. A new account gets a workspace of its own, or joins the workspace of its invite. The first account on a server becomes the owner of any workspace that has no members. |
| `POST /auth/login` | `{ email, password }`. Sets the session cookie. |
| `POST /auth/supabase` | `{ access_token, invite? }`. Only when Supabase sign-in is configured. |
| `POST /auth/logout` | Ends the session. |
| `GET /auth/me` | `{ user: { id, email, name, first_name, last_name, display_name, created, has_password }, workspaces: [{ id, name, slug, status, created, role, environments }] }`. |
| `PATCH /auth/me` | `{ name }`. |
| `POST /auth/password` | `{ current, password }`. Ends the person's other sessions. |
| `DELETE /auth/me` | `{ password }`, or `{ confirm: <email> }` for an account with no password. Deletes the account and each workspace that only this person is in. Refused with `sole_owner` while the person is the only owner of a workspace with other members. |
| `GET /auth/invites/:token` | No session needed. What an invite is for: `{ email, role, workspace_name, has_account }`. |
| `POST /auth/invites/:token/accept` | Join the workspace. The invite is for one email address. |

