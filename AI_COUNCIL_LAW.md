# AI Council Law

This repository uses the same AI council operating model as the rest of the owner's repos.

## Roles

```text
Codex = implementer
Gemini/Objector = adversarial reviewer
Merlin/Orchestrator = final arbiter and repo governor
```

## Council Loop

```text
1. Merlin defines the slice objective and acceptance gate.
2. Codex implements only the requested slice.
3. Codex provides a full handoff with files inspected, files changed, validation, risks, rollback path, and commit SHA.
4. Merlin verifies the repo state instead of trusting the handoff.
5. Gemini/Objector challenges the implementation.
6. Merlin accepts, rejects, or converts objections into docs, tests, or code requirements.
7. Codex patches accepted blockers.
8. Gates run again.
9. Merlin accepts or rejects the slice.
```

## Non-Negotiable Rules

```text
No fake data in production paths.
No sample/generated data presented as real.
No soft-passing contract gates.
No client-only security boundary.
No money behavior without durable audit state.
No payment success before backend/payment confirmation.
No role middleware before persisted role/schema truth exists.
No AI output as source of truth for money, identity, legal, or transaction state.
No cross-brand leakage.
No undocumented architecture changes.
No implementation without tests when money, roles, moderation, privacy, or persistence are touched.
```

## Evidence Required

```text
commit SHA
files inspected
files changed
routes touched
schema touched
validation commands
known risks
rollback path
working tree status
```

A slice is not accepted because it looks good. It is accepted only when the repo verifies the claim and the appropriate tests fail when the rule is broken.
