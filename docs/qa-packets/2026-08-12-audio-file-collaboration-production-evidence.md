# Audio File Collaboration Production Evidence — 2026-08-12

## Decision

**PRODUCTION VERIFIED for private project collaboration.** Two separately verified production accounts completed pairing, selected immutable-version sharing, exact download, review, approval, grant revocation, re-share, connection revocation, and replay denial on the exact deployed build. This promotes only the `project_collaboration` readiness capability; the complete-product decision remains `HOLD`.

## Requested Outcome

Prove the complete customer collaboration journey in production without treating pairing as authorization and without retaining account identities, passwords, session cookies, pairing tokens, grant identifiers, or object keys in the evidence packet.

## Run Identity

- Environment: `https://app.sway.tips`.
- Evidence date: 2026-08-12 America/Chicago (2026-08-13 UTC).
- Deployed merge: `b89d4033f8de55ba2c3a5a1dcf0bf566f1c3b48f` (PR #198).
- Fixture: generated WAV, `16,044` bytes, SHA-256 `105eaba643f522ec731431fd0035959ebd2e46f2f9f6248a53b912b2841739b0`.
- Identities: one synthetic creator account and one separate synthetic collaborator account, both verified in production; identifiers are redacted.
- Verifier: repository owner with Codex-assisted production browser and direct authenticated response checks.

## Independent Evidence

| Step | Result | Observed customer and server outcome |
| ---: | --- | --- |
| 1 | **PASS** | The creator opened Files → Collaboration and file sharing → Pair for files → Send files and rendered a pairing QR with a 15-minute expiry plus the warning that pairing alone grants no file access. |
| 2 | **PASS** | The collaborator opened the production connection page from the one-time pairing route, saw both expected identities and the no-access warning, and confirmed the connection. |
| 3 | **PASS** | The collaborator inbox showed the connection but no files. A direct request for the creator's immutable version returned HTTP 403 before pairing and remained HTTP 403 after pairing but before sharing. |
| 4 | **PASS** | In the production Files UI, the creator selected one immutable version and explicitly shared it with the connection for download, review, and approval. |
| 5 | **PASS** | The collaborator inbox showed the selected file, project, `16,044`-byte size, source-download action, review-note action, and approval action. |
| 6 | **PASS** | The collaborator download returned HTTP 200, `audio/wav`, exactly `16,044` bytes, and the expected SHA-256. |
| 7 | **PASS** | The collaborator added a review note and approved the version through the production UI. The collaborator and creator review histories both showed the note and approval. |
| 8 | **PASS** | The creator revoked the file grant through the two-step UI confirmation. Subsequent collaborator download and review requests both returned HTTP 410 while the pairing connection remained. |
| 9 | **PASS** | The creator shared the same immutable version again, producing a new active grant. |
| 10 | **PASS** | The creator removed the pairing connection through the two-step UI confirmation. The new grant was cascade-revoked; subsequent download and review requests both returned HTTP 410. |
| 11 | **PASS** | Final reconciliation showed zero active pairing connections and zero active file grants for the controlled journey. The collaborator UI showed no connections and no incoming shares. |

## Trust-Boundary Findings

- Pairing establishes a private relationship; it does not grant project or file access.
- File authority is scoped to one selected immutable version and explicit capabilities.
- A creator can revoke the file grant without removing the relationship.
- Removing the relationship cascade-revokes active file grants.
- Review history is durable and visible to both participants before revocation.
- Revoked resources return terminal HTTP 410 instead of silently preserving access.

## What Remains Unproven

Nothing remains for the bounded `project_collaboration` capability represented by this journey. Separate readiness rows still govern durable storage ownership, release assembly, provider delivery, royalties, splits, payouts, and catalog transfer.

## Rollback

- Application rollback: revert the collaboration runtime only if an authorization or integrity regression is observed; preserve its audit and review records.
- Automatic rollback trigger: pairing grants implicit access, an unshared account receives bytes, a revoked grant returns `2xx`, connection removal leaves an active grant, or an exact-byte/hash mismatch occurs.
- Observability signal: authorization response status, active connection/grant reconciliation, review audit history, and exact byte/hash comparison.

## Explicit Non-Claims

- This proof does not authorize DSP delivery, royalty accounting, collaborator payouts, live Stripe, or App Store submission.
- The retained synthetic fixture accounts are not approved for customer or operator use.
- A production UI observation without direct authorization and integrity checks would not be sufficient for this decision.
