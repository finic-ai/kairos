# Workspaces

Who can sign in, and what each role can do. A program uses an API key instead: see [Authentication](authentication.md). The endpoints are in the [API reference](../reference/api.md#accounts-and-workspaces).

## Accounts

Sign up at [kairos.finic.ai](https://kairos.finic.ai) with one of the options on the sign-in page. Always sign in with the method you signed up with: one email address is one account. A sign-in lasts 30 days.

Your name is in **Settings › Profile**, where you can also delete your account. An account that is the only owner of a workspace with other members cannot be deleted until another member is an owner.

## Workspaces

All data belongs to a workspace and one of its [environments](environments.md). A new account gets a workspace, and a person can create more and switch between them in the sidebar.

## Roles

| Role | Can |
|---|---|
| member | Use the console and the data, in every environment. Leave the workspace. |
| admin | Also invite and remove people, change roles, rename the workspace, and manage environments, API keys, webhooks and jobs. |
| owner | Also make and remove owners, and delete the workspace. A workspace always has one owner or more. |

## Invites

An admin enters an email address and a role in **Settings › Members** and gets a link. Kairos sends no email: the admin sends the link. The link is shown one time, works for 7 days, works once, and only for that address. A new invite to the same address replaces the old link.

A person who is invited and has no account yet creates one from the link. A person with an account joins the workspace when they open the link signed in.

## Two-factor authentication

On a server that signs in with Amazon Cognito, a person who signs in with a password can turn on an authenticator app in **Settings › Profile**: scan the QR code, then enter the first code. From then on, each sign-in asks for a code. Turning it on or off asks you to sign in again first. A Google account uses Google's own 2-Step Verification.

## Data retention

By default a workspace keeps all of its history. An owner or admin can set a period instead in **Settings › General › Data retention**: 30, 90, 180, 365 or 730 days, or any whole number of days from 7 to 3650. It applies to every environment of the workspace, Production too. Back to **Forever** stops the deletion; it does not bring back what was deleted.

Each hour, Kairos deletes what is older than the period:

- **Events**, with their entity links. Records and sessions are made of events, so their old stages go.
- **Decisions.** A newer decision whose event was deleted keeps its outcome and context.
- **Labels**, once their entity is not active: a label stays while its entity has an event, or a change to its properties, in the period.
- **Resolved cases** with no activity in the period, with their evidence, items and activity. An open case stays however old it is.
- **Workflow runs** that have finished, and **webhook delivery logs**. An outbound delivery still waiting to be sent stays.
- **Entities** not changed in the period that nothing kept names any more, with their properties.

Kept: definitions (actions, entity types, workflows, queues, dashboards), webhook endpoints, API keys, members and the workspace itself. Deleted data cannot be recovered. The first deletion starts at the next full hour. A short period on a workspace with years of history can take several hours to finish.
