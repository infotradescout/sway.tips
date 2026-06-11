# Sway Admin/Ops Behavior Extraction Plan

Status: planning-ready.

This plan starts after parity copy/config extraction closeout and defines behavior-level extraction sequencing for Admin/Ops without scope drift.

Reference closeout: `docs/SWAY_ADMIN_OPS_PARITY_EXTRACTION_CLOSEOUT.md`

## Goal

Move Admin/Ops runtime behavior out of legacy `src/shells/AdminApp.tsx` into focused compat components/helpers under `src/shells/admin/` while preserving current output and guardrails.

## Build-Order Constraints

- No schema changes in this slice.
- No payment behavior changes.
- No persistence behavior changes.
- No role/access model changes.
- No client-route security assumptions.
- No AI or moderation behavior expansion.

## Candidate Extraction Sequence

### Slice A: Locked secondary-panel behavior extraction

Extract locked-authority secondary panel composition from `src/shells/AdminApp.tsx` into a compat render helper/component in `src/shells/admin/`.

Acceptance:

- UI structure/copy remains equivalent.
- Existing runtime route and shell wiring remain unchanged.
- No new API/network/storage calls.

### Slice B: Demo branch composition extraction

Extract Admin/Ops demo branch assembly into compat logic to reduce legacy branch density in `AdminApp.tsx`.

Acceptance:

- `SplitViewShell` props remain equivalent for demo mode.
- Demo empty-state behavior remains equivalent.
- No production capability removals.

### Slice C: Locked fallback message extraction

Extract non-demo locked fallback `ShellMessage` composition into compat layer.

Acceptance:

- Locked fallback output remains equivalent.
- No role boundary drift.

## Required Validation Per Slice

- `npm run lint`
- `npm run build`
- `npm run test:contracts`

Target contracts to watch (non-exhaustive):

- route/shell boundary contracts
- admin/ops runtime parity contracts
- degraded/idempotency contracts that could regress via shell wiring changes

## Risks

- Unintended structure drift in locked-state composition.
- Hidden coupling to legacy local state in `AdminApp.tsx`.
- Accidental introduction of new responsibilities into compat module.

## Risk Controls

- Keep `AdminApp.tsx` as source-of-truth during staged extraction.
- Perform one behavior move per slice.
- Add/extend parity-focused contracts before deleting any legacy branch.
- Reject any extraction that adds API calls or persistence logic to compat files.

## Exit Criteria

Behavior extraction planning is complete when:

- extraction slices are scoped with acceptance criteria,
- guardrails are explicit and test-gated,
- and next implementation slice can proceed without re-opening copy extraction.
