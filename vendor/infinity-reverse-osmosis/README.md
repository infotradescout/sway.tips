# Shared reverse osmosis core

Portable ESM TypeScript, no dependencies. This is the shared proposal and exact
execution protocol for MealScout, Sway and TradeScout. Native owners retain
field allowlists, consent UX, branding, permissions, database transactions and
provider clients. Never expose a NativePort to an untrusted client. Fields must
be native-policy-approved normalized JSON; never pass credentials, raw tokens or
raw provider payloads.

```ts
import { createReverseOsmosisEngine } from "@tradescout-infinity/reverse-osmosis";
const engine = createReverseOsmosisEngine(nativePort);
const proposal = await engine.propose({
  scope: {
    product: "tradescout",
    businessId,
    ownerId,
    tenantId: businessId,
    subjectId: profileId,
    provider: "social",
    accountId,
  },
  direction: "social-to-native",
  eventId,
  sourceVersion,
  expectedNativeVersion: String(contentBlocksRevision),
  fields: { bio },
});
// Native consent flow approves this exact immutable digest and target.
await engine.apply(proposal, exactApproval);
// Native-to-social proposals use engine.publish(proposal, exactApproval).
// Proposal construction never applies or publishes anything.
```

`ExactApproval` binds scope, direction, eventId, sourceVersion,
expectedNativeVersion, payloadDigest, businessBindingRevision and native
approvalId. Both versions are distinct: sourceVersion identifies the source
event revision; expectedNativeVersion is the precise native target CAS revision.
Scope.subjectId identifies the profile, not merely its business. Core computes
SHA-256 using standard Web Crypto and freezes normalized plain JSON before
asynchronous work. It accepts only bounded JSON data, rejecting getters,
symbols, prototypes, cycles and nonfinite numbers. Native policy chooses the
allowed field names and privacy projection before constructing proposals.

`NativePort.authorizeAndClaim({proposal,approval})` must atomically validate
current authorization, consent, exact approval, target identity and
expectedNativeVersion CAS and persist exclusive durable ownership before
effects. Store operationKey with full scope, both versions and payloadDigest;
reject a different payload on the same key. Keys scope product, tenant, subject,
provider, account, direction, event and sourceVersion; expectedNativeVersion
stays in the payload digest so a changed CAS on the same source event conflicts.
Duplicate claims cannot execute again, including concurrent requests and process
restarts. A returned replay outcome requires current authorization before
disclosure.

Only the native port mints opaque claims. `executeClaimed(claim)` must verify
its own durable capability and revalidate current authority atomically at effect
initiation. A generic permission callback followed later by an unguarded effect
is insufficient. Native code owns durable completion receipts and must never
release claims on unknown exceptions or crashes. The core catches unknown effect
failures and invokes `holdUncertain`; if hold persistence fails it raises
`UncertainEffectError` with holdPersisted false. The original durable claim must
remain uncertain and nonretryable. This core cannot manufacture durability for a
faulty adapter.

`authorizedOutcome(proposal)` and `reconcile(proposal)` recompute proposal
integrity and send the exact frozen context to the native port. Native
implementations must check full scope/key/digest and reauthorize disclosure.
Reconciliation verifies provider delivery or absence using native evidence; only
proven absence may permit a separately authorized retry. Do not implement
reconciliation as a blind resend.

Optional `verifyReflection(proposal)` must verify matching causal provenance of
a prior completed native operation including exact payload/version/target. It
must also check current authority before returning true. The native
authorizeAndClaim transaction may return a durably recorded `reflected` outcome
only after current exact consent and approval validation. The core additionally
verifies native causal evidence before disclosure; there is no early synthetic
reflection return. Caller origin labels alone cannot suppress a new human edit.
Reflection is not a completed application/publication.

This package is an implementation protocol and local tests, not evidence that
native transactions, provider adapters or deployments are installed. No provider
effects occur in its tests.

Mandatory business asset contract: verifyBusinessAsset(proposal) performs a
read-only native connector verification. It returns frozen-safe
BusinessAssetEvidence with exact scope, providerAssetId=accountId,
nativeBusinessId=businessId, nativeSubjectId=subjectId and
authorizedOwnerId=ownerId; assetKind must be business-page, business-account or
business-channel. providerVerified and ownerAuthorized must be true, revoked
false, verifiedAt no more than 60 seconds old and not future, expiresAt in the
future, and bindingRevision nonempty. The core verifies and snapshots this
evidence. Personal feeds, unknown assets and sibling managed assets are rejected
even if a personal administrator manages both. Evidence must come from trusted
native connector state, never client claims. Native initiation must atomically
recheck business attachment, authority and binding revision along with durable
claim ownership. This requirement also applies to replay and reconciliation;
revoked policy never releases uncertain holds.

The core adds businessBindingRevision to its proposal output and hashes it with
the exact canonical payload. Native exact approval must include that revision.
Fresh connector evidence on execution must match the approved binding. Changing
business attachment invalidates prior proposals. Operation keys do not include
binding revision, expectedNativeVersion, payload or approval, preventing new
keys from bypassing collision protection.

Every outcome path is centrally snapshotted and must match operationKey and
payloadDigest with an allowed status and safe JSON receipt. Unknown execution
outcomes or invalid execution receipts retain a reconciliation hold. Native
durable claims left by a crashed process must never auto-execute on a second
call; replay returns held until explicit owner reconciliation. The shared
reconciliation API requires a currently verified business binding. Under revoked
connections, separately authorized native bookkeeping may record proven prior
delivery or absence without a new effect; the hold is never discarded or
automatically retried merely because shared reconciliation is blocked.
