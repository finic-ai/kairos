# Agent Rules

## Branches

Name branches `{type}/{name}`. Use a short kebab-case name.

- `feat/` for new features
- `bug/` for bug fixes
- `docs/` for documentation changes only
- `chore/` for tooling, dependencies, config, and other maintenance
- `refactor/` for code changes that do not change behavior

```
feat/case-views
feat/model-registry
bug/alert-dedupe
```

## Commits

Write commit messages as `{type}: {message}`. The type matches the branch type.

- Use present tense, imperative mood: "Add", not "Added" or "Adds".
- Start the message with a capital letter. Do not end it with a period.
- Keep the subject line under 72 characters. Put more detail in the body if needed.
- Do not add `Co-Authored-By` trailers or any other agent attribution to commits.

```
# ✅ GOOD
feat: Add case views page
bug: Fix duplicate alerts on refresh
docs: Add Python SDK quickstart
chore: Upgrade pnpm to v9
refactor: Extract workflow step runner

# ❌ BAD
feat: Added case views page
bug: fixes duplicate alerts.
Update stuff
```

## Pull Requests

- Title the PR in the same format as a commit: `{type}: {message}`.
- Do not add co-author lines, "Generated with" footers, session links, or any other agent attribution to the PR title or body.

## Code Comments

Add a comment only when the code cannot explain itself: a non-obvious constraint, a workaround, or a reason a reader would not guess. Delete all other comments aggressively, including existing ones in code you touch.

Do not write:

- Comments that repeat what the next line does.
- Large comment blocks or banners that describe a file or function at length.
- Comments that explain your change, its history, or why it is correct. That belongs in the commit message or PR.
- Commented-out code.

```ts
// ❌ BAD
// Loop over the alerts
for (const alert of alerts) {
  // Increment the counter
  count++;
}

// ✅ GOOD
// Snowflake returns NUMBER columns as strings above 2^53.
const amount = BigInt(row.AMOUNT);
```

## Docs

The pages in `docs/` are published at `/docs`, in the order of `apps/console/docs/pages.ts`. They have three readers:

- **Customers** of `https://kairos.finic.ai`: every group but Deployment. Write what a customer sees and does. No `pnpm`, `localhost`, repository paths, internal libraries or server settings (`KAIROS_*`, `SUPABASE_*`, `DATABASE_URL`).
- **Operators** of a self-hosted server: the Deployment group (`docs/deployment/`). Every server setting goes there, and a customer page links to it.
- **Contributors**: `docs/development/`, which is not published.

The docs build warns about a customer page that breaks this. Build with `pnpm --filter @kairos/console build` and fix every warning.


## Migrations

Create a migration only when the schema must change, and think about the design first.
- A PR has at most one migration. When the schema changes again during the PR, change or regenerate that migration. Do not add a second one.
- Start from `pnpm --filter @kairos/server db:generate`, so that the snapshot matches the schema. Edit the SQL by hand when the generator cannot express the change, such as a data backfill, a SQL function, or an index it does not make. Say why in the PR.
- After a migration is merged or deployed to production, do not edit or delete it: a database may have run it. You can add a new migration instead.
- Give each table an `id` (a prefix and a ULID, from `newId`), `created` and `updated`. A table whose rows never change has no `updated`. A link table, such as `event_entities`, can use a composite primary key.
- Use `jsonb` for settings and metadata. Use `json` for what the model reads or what a person wrote in an order: event and entity properties, action and entity definitions, the decision context. `jsonb` sorts the keys, and the key order changes the model's answers.
- Scope every customer table by `workspace_id` and `environment_id`.