# Sway DRY Refactor Intake Checklist

DRY/SRP targets are read-only audit targets in this lane.

No runtime refactor is approved by this document alone. A separate refactor lane is required.

## Oversized Files Target List Placeholder

- File:
- Approximate size:
- Risk:
- Candidate extraction:

## Duplicated Logic Target List Placeholder

- Location A:
- Location B:
- Behavior to preserve:
- Candidate shared helper/component:

## Repeated Try/Catch Target List Placeholder

- Files:
- Error behavior today:
- User-facing copy today:
- Candidate error wrapper:

## Raw Fetch Bypass Target List Placeholder

- Files:
- Endpoint:
- Existing wrapper to prefer:
- Behavior parity risk:

## Repeated Formatters/Helpers Target List Placeholder

- Files:
- Formatter/helper:
- Differences:
- Candidate consolidation:

## Repeated UI Components Target List Placeholder

- Components/screens:
- Shared pattern:
- Accessibility requirements:
- Candidate component:

## Behavior-Preserving Extraction Plan

- Current behavior:
- Tests/contracts before:
- Extraction steps:
- Tests/contracts after:
- Manual QA after:

## Test-Before/Test-After Requirement

- Record tests before refactor.
- Record tests after refactor.
- Record any changed output.
- Explain any intended difference.

## Separate Refactor Lane Requirement

No opportunistic cleanup inside feature lanes.

Each refactor lane must have:

- Scope boundary
- Behavior-parity evidence
- Re-QA evidence
- Rollback path

