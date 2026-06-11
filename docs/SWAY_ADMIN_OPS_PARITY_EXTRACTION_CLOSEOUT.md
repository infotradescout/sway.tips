# Sway Admin/Ops Parity Extraction Closeout

Status: parity extraction sequence complete through Phase 11.

This document closes the Admin/Ops parity extraction chain and marks the handoff point from copy/config extraction into behavior-level extraction planning.

## Completed Chain

- Phase 5: Admin/Ops runtime compatibility boundary established.
  - `src/shells/AdminOpsRuntime.tsx` delegates through `createAdminOpsRuntimeCompat(AdminApp)` from `src/shells/admin/AdminOpsRuntimeCompat.tsx`.
- Phase 6: `ADMIN_OPS_DEMO_SECTION_LABELS` extracted.
- Phase 7: `ADMIN_OPS_DEMO_ITEM_BODY` extracted.
- Phase 8: `ADMIN_OPS_EMPTY_STATE_COPY` extracted.
- Phase 9: `ADMIN_OPS_DEMO_HEADING` extracted.
- Phase 10: `ADMIN_OPS_LOCKED_TITLE` extracted.
- Phase 11: Admin/Ops parity extraction closeout documented and committed.

Closeout commit:

- `2e2642cbdeea2b53f352b0c64a019779438d52e9`

## Current Status

- Parity extraction: complete.
- Admin/Ops compatibility layer: established.
- Remaining work: behavior extraction (not copy extraction).

## Current Compat Exports

From `src/shells/admin/AdminOpsRuntimeCompat.tsx`:

- `ADMIN_OPS_DEMO_SECTION_LABELS`
- `ADMIN_OPS_DEMO_ITEM_BODY`
- `ADMIN_OPS_EMPTY_STATE_COPY`
- `ADMIN_OPS_DEMO_HEADING`
- `ADMIN_OPS_LOCKED_TITLE`
- `createAdminOpsRuntimeCompat(LegacyAdminApp)`

## Remaining Legacy Responsibilities

Remaining responsibilities still owned in `src/shells/AdminApp.tsx`:

- Demo-mode branch composition for Admin/Ops shell rendering.
- `SplitViewShell` composition and prop wiring for Admin/Ops demo surface:
  - `title`, `eyebrow`, `primaryLabel`, `secondaryLabel`, `badge`, `isEmpty`, `emptyState`, `primary`, `secondary`.
- Locked-authority visual composition:
  - icon block and text block layout in the secondary panel.
- Non-demo fallback `ShellMessage` composition for locked Admin/Ops state.

## First Real Behavior Extraction Candidate

Candidate: locked-authority display composition extraction (parity-only).

Scope for next slice:

- Extract the secondary locked-authority JSX composition from `src/shells/AdminApp.tsx` into an Admin/Ops compatibility helper component or render function under `src/shells/admin/`.
- Keep rendered output byte-for-byte equivalent in copy and structure where practical.
- Keep all existing route/runtime wiring unchanged.

Out-of-scope and prohibited drift:

- No route changes.
- No schema changes.
- No money/payment changes.
- No persistence changes.
- No role/access changes.
- No AI behavior changes.
- No moderation behavior changes.

## Risk Controls

To preserve parity while moving toward behavior extraction:

- Keep `AdminApp.tsx` as legacy source-of-truth until behavior parity contract passes.
- Expand parity contracts incrementally to assert:
  - Admin route mounting remains `AdminOpsShell` via `src/entries/admin.tsx`.
  - `AdminOpsRuntime` remains delegated through compat factory.
  - Existing copy/config constants remain sourced from compat module.
- Reject any change that introduces API/network/storage calls in compat extraction files.
- Keep `npm run lint`, `npm run build`, and `npm run test:contracts` as required gates for every extraction slice.
