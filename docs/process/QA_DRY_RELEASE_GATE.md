# Sway QA DRY Release Gate

Zachary's QA + DRY direction is mandatory operating law for Sway lanes.

This release gate applies before approval, merge, or deployment posture for every user-facing feature, runtime refactor, product polish lane, or release lane.

## Required Operating Order

1. QA the current user experience.
2. Fix what is broken or confusing.
3. Clean up duplicated/oversized code safely.
4. Re-QA after cleanup.
5. Only then introduce new features.

## Merge Law

- No new feature stacking before Critical/High UX and maintainability issues are addressed.
- No new feature stacking before Critical/High issues are explicitly owner-approved with documented risk.
- No merge posture without completed release evidence.
- No user-facing merge without QA evidence.
- No pure refactor merge without behavior-parity evidence.
- No pure refactor merge without re-QA evidence.
- Simulated validation output is a fatal release-blocking violation.
- Runtime refactors require a separate scoped lane and behavior-parity evidence.
- Feature work remains blocked until current UX has been audited and Critical/High issues are fixed or explicitly accepted.

## Evidence Standard

Release evidence must use real command output, real route evidence, and real manual QA notes. Claims such as "tested conceptually", "assumed pass", "simulated output", or "would pass" are not valid evidence.

## Scope Separation

QA, fixes, DRY/SRP cleanup, and feature work must be separate lanes unless the owner explicitly approves a combined lane with documented risk.

