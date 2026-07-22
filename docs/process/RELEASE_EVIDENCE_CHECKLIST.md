# Sway Release Evidence Checklist

Release evidence must use real command outputs only.

No simulated validation is allowed. Simulated validation, invented command output, or soft-pass language is release-blocking.

## Requested Outcome

- Human intent:
- Constraints:
- Risk tolerance:
- Architecture boundaries:
- Acceptance criteria:

## Independent Evidence

- Implementer:
- Independent verifier or enforcing system:
- Environment:
- Evidence source:
- Observed result:
- Why this evidence supports the requested outcome:
- What remains unproven:

## Local Validation Command List

- `npm run audit:contracts --if-present`
- `npm run lint --if-present`
- `npm run build`
- `npm run test:contracts --if-present`
- `git diff --check`

Record exact output or attach the log location.

## Production Marker Evidence When Deploying

- Intended production commit:
- Observed production commit:
- Observed timestamp:
- Apex marker result:
- `www` marker result:
- App subdomain marker result:
- Render origin marker result:
- Marker confirms deployed identity only; customer outcome verified separately:

## Route Smoke Evidence

- Public landing route:
- App root route:
- Patron route:
- Talent route:
- Admin/operator route:
- Overlay route:
- Error route:

## Role/Access Smoke Evidence

- Unauthenticated:
- Patron:
- Performer:
- Admin/operator:
- Support:
- Denied:

## Demo Fixture Boundary Evidence

- Production does not show demo fixture data:
- Forced demo env cannot override production boundary:
- Dev/demo mode remains explicit and labeled:
- Public links do not route to hardcoded demo UUID state:

## Rollback Path

- Rollback commit:
- Rollback command or deploy action:
- Routes to verify after rollback:
- Automatic rollback trigger:
- Observability signal that activates the trigger:

## Complete-Product Readiness

- `npm run readiness:report` result:
- `npm run readiness:assert` result:
- DistroKid-replacement pillar evidence:
- Original-Sway pillar evidence:
- Cohesive one-account journey evidence:

## Known Risks

- Risk:
- Severity:
- Owner decision:
- Follow-up:

## Owner Approval Field

- Owner:
- Decision:
- Date:
- Conditions:

