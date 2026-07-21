# Incident Record: Pro Mode Migration Gap

Date: 2026-07-20
Status: Resolved. Recorded for future schema-changing PR review, not a currently open risk.

## Summary

Phase 2 Slice 1A (universal Pro Mode account state, migrations `0021`/`0022`) was merged and deployed to production application code before its schema migration had actually run against the production database. The deploy pipeline had no step that applied Drizzle migrations, so the new code paths assumed columns and tables that did not yet exist in production.

## The Schema Assumption That Failed

The deploy process assumed that merging a PR containing new `drizzle/*.sql` migration files was sufficient for those migrations to reach production. In fact, `render.yaml` only ran `npm ci && npm run build` before `npm run start` — nothing in the pipeline ever invoked `drizzle-kit migrate` (or any migration runner) against the production database. Migrations were being generated and committed, but never automatically applied. Whatever had reached production before this incident had gotten there through ad hoc manual runs, not a repeatable pipeline step.

## Why Production Lacked The Migration

There was no `preDeployCommand` (or equivalent) in `render.yaml`. Render's deploy lifecycle has a dedicated hook for exactly this — a command that runs after build but before the new instance takes traffic — and it was simply never wired up. `drizzle-kit check` (which had been used for local verification) only validates that the local migration files are internally consistent; it never connects to or compares against the live database, so it could not have caught this gap.

## Migration Ledger Reconciliation

Once a real drift was suspected, the production `drizzle.__drizzle_migrations` table was compared against local migration file hashes directly (not just row counts). This surfaced three distinct, unrelated conditions that had to be handled differently:

- Migrations `0015`, `0019`, `0020`, `0021`, `0022` were genuinely never applied — no ledger row, no corresponding schema objects in production.
- Migrations `0014`, `0016`, `0017`, `0018` had been applied to production at some point via `drizzle-kit push` (schema objects present) but had no ledger row recorded.
- Migrations `0012`/`0013` had ledger rows, but with hashes that no longer matched the current local migration files (the files had been edited/regenerated after they were originally applied). The underlying table objects were confirmed present and correct; this was a cosmetic hash drift, not a missing migration.

The genuinely-missing migrations were applied directly (their raw SQL, not a full sequential `drizzle-kit migrate` replay, to avoid risk from replaying already-applied earlier migrations). The ledger was then separately reconciled with metadata-only inserts for the push-applied and hash-drifted migrations, so that `drizzle-kit migrate` going forward is a clean, accurate no-op against current production state. This was verified directly rather than assumed.

## How The Deploy Pipeline Now Closes The Gap

`render.yaml` now sets:

```yaml
preDeployCommand: npm run db:migrate
```

where `db:migrate` runs `drizzle-kit migrate`. Render's platform contract is that a failing `preDeployCommand` blocks the deploy — the new application version does not take traffic if migrations fail. This makes "migrations ran against production" part of every deploy, not a manual step someone has to remember. See `docs/SWAY_ENVIRONMENT_CONTRACT.md` and `docs/SWAY_PRODUCT_SPINE.md` for the corresponding hard-rule statements, and `scripts/sway-deploy-migration-gate.contract.test.mjs` for the static regression check that this wiring stays in place.

## Unrelated Issue Found During The Same Window: Email Delivery

While validating the repaired deploy, real-world signup email delivery (used for performer email verification) was independently found broken, in two sequential ways:

1. The configured Brevo API key was stale/mismatched and Brevo returned 401 on send attempts.
2. After the key was rotated, sends still failed because the Brevo account had an IP-authorization restriction that blocked Render's outbound IP range.

Both were owner-side account configuration issues, not application bugs, and were resolved by rotating the key and disabling the IP restriction on the Brevo account. This is recorded here because it was discovered in the same incident-response window, but it is a distinct root cause from the migration gap — see `docs/SWAY_ENVIRONMENT_CONTRACT.md` for the corrected production dependency note (Brevo, not Resend; IP-allowlist caveat).

## Evidence

- Production build-marker endpoint (`/api/build-marker`) confirmed the deployed commit SHA matched the intended merge commit after each of PRs #105-#109.
- Direct comparison of `drizzle.__drizzle_migrations` rows (hash + applied timestamp) against local `drizzle/meta/_journal.json` entries, before and after reconciliation.
- Post-reconciliation `drizzle-kit migrate` run returned "no pending migrations" against production, confirmed clean.
- A live performer signup completed end-to-end (verification email received, link worked) after the Brevo fixes, confirmed by the user.

## What To Check On Future Schema-Changing PRs

- Does `render.yaml` still declare `preDeployCommand: npm run db:migrate`? (Enforced by `scripts/sway-deploy-migration-gate.contract.test.mjs`.)
- After merge, does the production build-marker show the new commit AND does a direct query (or `drizzle-kit check` plus a targeted row check for the new table/columns) confirm the new schema objects actually exist in production? Marker match alone only proves the code deployed, not that its schema did.
- Never treat `drizzle-kit check` as proof that production is migrated — it is a local-file-consistency check only, not a live-database check.
- If a migration is later edited/regenerated after being applied somewhere, expect a hash mismatch in the ledger; confirm via direct object inspection (not row-count) whether it's cosmetic drift or a genuinely missing migration before taking any corrective action.
