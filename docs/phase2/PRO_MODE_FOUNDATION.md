# Sway Phase 2: Universal Accounts and Pro Mode Foundation

Status: foundation in progress

## Locked product decisions

- Every person uses one canonical Sway account.
- Patron/listener entry starts with Pro Mode disabled.
- Performer/creator entry starts Pro Mode onboarding.
- A user can activate Pro Mode later without creating another account.
- Pro Mode unlocks creator publishing, live rooms, monetization, collaboration, secure file sharing, exclusives, analytics, and promotion capabilities.
- The core Pro plan is advertised at $19 per month after public launch.
- Qualifying public-beta users receive core Founding Pro access free for life.
- Founding Pro access must not depend on a Stripe subscription, indefinite trial, or manually cancelled invoice.
- Active post-beta members can earn Sway Credits through legitimate product activity.
- Credits have no cash value, are not withdrawable, and cannot exceed the eligible subscription charge.
- Founding Pro accounts do not consume credits for core access.

## Confirmed current repository architecture

The current implementation uses:

- a `users.role` enum with `patron`, `performer`, `admin`, and `support` values;
- a separate `performers` record linked through `performers.owner_user_id`;
- performer memberships and gig access grants for durable talent authorization;
- performer-specific browser sessions and login flows;
- Drizzle/PostgreSQL persistence;
- Stripe and Stripe Connect boundaries;
- append-oriented audit records and extensive contract tests.

The current role field cannot safely become the long-term capability source without a migration plan. Phase 2 therefore begins additively: Pro Mode and entitlements become capability state while the legacy role remains in place for compatibility.

## First implemented policy boundary

`src/server/pro-mode-policy.ts` defines:

- canonical Pro Mode states;
- the $19 core-plan price in cents;
- Founding Pro qualification evaluation;
- core Pro access resolution;
- subscription-credit application behavior.

The policy is intentionally persistence-neutral. It can be tested before database tables, billing hooks, or user-interface controls are introduced.

## Required next persistence slice

The next slice should add durable tables for:

1. Account capability state
   - `user_id`
   - Pro Mode status
   - onboarding, activation, suspension, and revocation timestamps
   - explicit reason and audit metadata

2. Account entitlements
   - user
   - entitlement type
   - status
   - scope
   - grant source
   - offer and terms versions
   - effective, expiration, suspension, and revocation timestamps

3. Founding Pro qualification
   - user
   - offer version
   - verification evidence
   - creator-profile publication evidence
   - terms acceptance receipt
   - granted entitlement reference

4. Sway Credit ledger
   - immutable grant and reversal entries
   - rule version
   - source entity
   - amount
   - expiration
   - subscription application reference
   - fraud and reversal relationship

Database work must include a generated Drizzle snapshot. This repository explicitly guards against adding migrations without the latest snapshot.

## Compatibility rule

Until the migration is complete:

- `users.role` remains available for existing route and administrative behavior;
- performer ownership and memberships remain valid;
- no patron or performer records are destructively converted;
- new Pro Mode checks must be additive;
- admin and support authorization remains role-based;
- live-room mutation authorization continues to use ownership, memberships, and gig grants.

## Planned vertical slices

1. Policy foundation and contract tests.
2. Durable Pro Mode, entitlement, and Founding Pro persistence.
3. Account-state API and same-account Pro Mode activation.
4. UI toggle and onboarding progress.
5. Public-beta qualification and entitlement grant.
6. Post-beta trial and paid-subscription boundary.
7. Sway Credit ledger and invoice application.
8. Self-publication and release model.
9. Followers and Following/Discover/Live feeds.
10. Sway Exclusives and collaboration workspaces.

## Safety constraints

- No fake users, credits, activity, earnings, releases, or followers.
- No card required for Founding Pro qualification.
- No recurring subscription is created for Founding Pro accounts.
- No credits are created for empty clicks, repeated login, refreshes, self-referrals, refunded transactions, disputes, or self-funded activity.
- Creator earnings, tip principal, withdrawable balances, and Sway Credits remain separate accounting lanes.
- A paid request never buys control over a performer.
