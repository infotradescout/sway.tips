# Sway Feature QA Checklist

## Branch Scope

- Branch:
- Commit under review:
- Business goal:
- Explicit non-goals:

## User-Facing Routes Touched

- Route:
- User type:
- Expected behavior:
- Evidence:

## Acceptance Criteria

- Criterion:
- Pass/Fail:
- Evidence:

## Regression Surfaces

- Public landing:
- Patron app:
- Performer/talent app:
- Admin/operator app:
- Overlay:
- API-visible errors:
- Mobile layout:

## Role/Access Checks

- Patron:
- Performer:
- Admin/operator:
- Support:
- Unauthenticated:
- Denied:

## Data-State Checks

- Empty state:
- Loading state:
- Error state:
- Success state:
- Refresh/deep link:
- Stale data:
- Realistic messy data:

## Money/Payment Checks When Applicable

- Payment behavior touched: yes/no
- Idempotency evidence:
- Audit/ledger evidence:
- Refund/void/capture evidence:
- Copy truth evidence:

## Production Demo-Data Boundary Check

- Production routes do not show demo data:
- Demo fixtures are gated to explicit non-production demo mode:
- Public links do not route to hardcoded demo UUID state:
- Evidence:

## Explicit Pass/Fail Evidence Fields

- Command:
- Exact output:
- Manual QA step:
- Expected:
- Actual:
- Pass/Fail:
- Screenshot/video reference:
- Reviewer:
- Date:

