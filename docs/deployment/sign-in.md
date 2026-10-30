# Sign-in and access

Who can create an account on your server, and how people sign in. For what a person can do once signed in, see [Workspaces](../platform/workspaces.md).

## The first account

There is no admin user to configure. **The first person to create an account on a new server owns it**: they get a workspace, and any workspace that exists with no members, such as one that was imported.

So, on a server that others can reach:

1. Start it.
2. Create your account at once.
3. Set `KAIROS_SIGNUP=invite` and restart. From then on, a new account needs an invite link from an owner or an admin (**Settings › Members**).

## Who can sign up

| `KAIROS_SIGNUP` | |
|---|---|
| not set | Anyone who can reach the server can create an account. |
| `invite` | A new account needs an invite link. |

Kairos sends no email. An invite is a link that an admin passes on, valid for 7 days, once, and for one email address. There is no password reset: a person who forgets a password needs a new account.

## Email and password

Each server offers sign-in with an email address and a password of at least 8 characters. Passwords are stored as bcrypt hashes. A session lasts 30 days, in an `HttpOnly`, `SameSite=Lax` cookie; the server stores only a hash of its token. Behind HTTPS, set `KAIROS_TRUST_PROXY=1` so that the cookie is also marked `Secure` (see [Self-hosting](self-hosting.md#https-and-a-reverse-proxy)).

## Supabase and OAuth

Kairos can also offer sign-in through [Supabase Auth](https://supabase.com/docs/guides/auth): email and password, and each OAuth provider enabled in your Supabase project, such as Google or GitHub.

| Variable | |
|---|---|
| `SUPABASE_URL` | The URL of your Supabase project. |
| `SUPABASE_ANON_KEY` | Its anon key. Both are needed. |
| `SUPABASE_PROVIDERS` | The OAuth providers to show, for example `google,github`. |

The browser signs in with Supabase and sends the access token to `POST /auth/supabase`. The server asks Supabase who the token belongs to, then starts its own session. An address that already signs in with a password cannot also sign in with Supabase: the route answers 409 `email_taken`. Without the variables, the route answers 404 and the sign-in page shows no Supabase option.

## Amazon Cognito

Kairos can sign people in through an [Amazon Cognito](https://docs.aws.amazon.com/cognito/) user pool instead: its managed login page does email and password, the checks of new addresses, password resets and two-factor authentication, as the pool is set up.

| Variable | |
|---|---|
| `COGNITO_DOMAIN` | The domain of the pool's managed login, such as `https://auth.example.com`. |
| `COGNITO_ISSUER` | The pool's issuer, `https://cognito-idp.<region>.amazonaws.com/<pool id>`. |
| `COGNITO_CLIENT_ID`, `COGNITO_CLIENT_SECRET` | A confidential app client of the pool. |
| `KAIROS_PUBLIC_URL` | The address people open Kairos at. Add `<KAIROS_PUBLIC_URL>/auth/cognito/callback` to the app client's callback URLs. |
| `COGNITO_PROVIDERS` | Optional. Providers to offer as buttons, such as `Google`. |

Set all of the first five values, or none: a part of them stops the server. With Cognito on, Kairos keeps no passwords: `POST /auth/signup` and `POST /auth/login` answer 404. Choose the sign-in when you deploy, because accounts that sign in with a password cannot sign in after Cognito is turned on.

The server trades Cognito's code for an ID token with the client secret and PKCE, and checks the token's signature against the pool's keys, its issuer, its audience and its expiry before it starts its own session. Signing out also signs out of Cognito. As with Supabase, each account has one way to sign in, and invites and `KAIROS_SIGNUP=invite` work the same way.

**Two-factor authentication.** With the pool's MFA set to optional, a person who signs in with a Cognito password turns an authenticator app on and off in **Settings › Profile**. The app client needs the scope `aws.cognito.signin.user.admin`. The callback keeps the person's Cognito access token in an `HttpOnly` cookie that is sent only to `/auth/mfa`. Turning it on or off needs a sign-in in the last 10 minutes, so a session left open cannot change it. Keep the app client's access token short, such as 15 minutes: the token can also change the person's account in Cognito directly.

## How the server keeps credentials

- API keys, session tokens and invite tokens are stored as SHA-256 hashes, never in the clear. A key is shown once.
- Webhook signing secrets and inbound webhook secrets are encrypted with `KAIROS_ENCRYPTION_KEY`.
- Every query is confined to one workspace and one environment, and a workspace you are not in answers as if it did not exist.
