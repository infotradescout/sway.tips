# Sway Bug Priority Guide

## Critical

Blocks the core user flow, exposes fake/demo/internal data as production, breaks money or persistence truth, violates role/access boundaries, creates a security/privacy risk, or makes production untrustworthy.

Critical issues block release unless explicitly owner-approved with documented risk.

## High

Confuses the primary user journey, breaks an important secondary action, causes mobile layout failure, hides recovery from API errors, or makes a user-facing claim that does not match implemented behavior.

High issues block release unless explicitly owner-approved with documented risk.

## Medium

Creates friction, inconsistent copy, non-critical accessibility issues, or a workaround-dependent flow that does not block the release path.

## Low

Polish, minor copy clarity, small visual inconsistencies, or non-blocking improvements that can safely wait.

## Owner Approval

Any Critical/High release exception must include:

- Issue summary
- User impact
- Risk accepted
- Owner approval
- Follow-up lane
- Rollback or mitigation

