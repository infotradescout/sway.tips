# Audio Master Vault Deployment and Recovery

This runbook governs Sway's exact-original private audio storage. A configured bucket, successful deploy, or passing local test is not proof that production masters are durable, authorized, and recoverable.

## Architecture Boundary

Cloudflare R2 is the production byte store. Render runs the Sway application but does not own or mount creator masters.

```text
authenticated Sway server
  -> private R2 multipart staging key
  -> complete multipart upload
  -> server-side copy into masters/ namespace
  -> download and verify exact byte count plus SHA-256
  -> delete staging object
```

PostgreSQL remains authoritative for projects, ownership, access grants, upload sessions, immutable asset-version identity, private candidates, provider-operation intent and attempts, cleanup receipts, checksums, rights evidence, and audit history. R2 contains only opaque object keys and bytes. The bucket must remain private; never enable an `r2.dev` URL or public custom domain for the master bucket.

The vault is not an unlimited general-purpose file locker. PostgreSQL calculates a per-performer working-storage balance from active multipart reservations, every sealed private candidate, and sealed versions that are not named in an immutable, validated release-package manifest. The default pool is 5 GiB with at most 10,000 working-file records, preventing both byte-volume and tiny-object abuse. Release count is unlimited. Exact package versions graduate from working-pool accounting without moving or deleting their immutable objects; private candidates never graduate in the current slice, and a mutable release or delivery status, later attachment, or provisional document never grants an exemption.

Manifest creation must re-open the exact object and pass the release parser. Masters are limited to 4 GiB and must report matching playable audio metadata; artwork is limited to 50 MiB and must decode with a strict container ending; rights documents are limited to 10 MiB and may not contain PDF attachments, portfolios, scripts, or launch actions. A parser failure rolls back the final readiness review and leaves every byte charged to working storage so the creator can replace the bad file and retry.

The application performs `HeadBucket` before accepting traffic. Missing credentials, an inaccessible bucket, or a configured local filesystem in production fails startup.

## Required Cloudflare Setup

1. Create a private R2 bucket named `sway-audio-originals`.
2. Create a bucket-scoped R2 API token with only the access required to inspect the bucket and read/write objects. Do not use a global Cloudflare API token.
3. Keep public development URL access and public custom domains disabled.
4. Decide and record the `masters/` bucket-lock retention policy before general availability. Retention must account for creator deletion requests, legal holds, takedowns, and recovery needs.
5. Establish a separately controlled recovery copy or export process. Provider durability does not protect against every authorized deletion or credential compromise.

## Required Render Secrets

```text
SWAY_AUDIO_STORAGE_PROVIDER=r2
SWAY_AUDIO_R2_ACCOUNT_ID=<Cloudflare account ID>
SWAY_AUDIO_R2_ACCESS_KEY_ID=<bucket-scoped R2 access key>
SWAY_AUDIO_R2_SECRET_ACCESS_KEY=<bucket-scoped R2 secret>
SWAY_AUDIO_R2_BUCKET=sway-audio-originals
SWAY_AUDIO_WORKSPACE_LIMIT_BYTES=5368709120
SWAY_AUDIO_WORKING_OBJECT_LIMIT=10000
SWAY_AUDIO_COLLABORATOR_REVISION_UPLOAD_ENABLED=false
```

The three credential values are declared `sync: false` in `render.yaml`; Git never contains them. They must be installed in the live Render service's secret environment.

`GET /api/runtime-config-status` must report:

```json
{
  "audioStorage": {
    "enabled": true,
    "provider": "r2",
    "objectStorageVerified": true,
    "workingStorageBounded": true,
    "workspaceLimitBytes": 5368709120,
    "workingObjectLimit": 10000,
    "releaseCountLimit": null
  }
}
```

The endpoint intentionally exposes no account ID, bucket name, key, secret, object path, or user data.

## Automated Evidence

Run:

```powershell
npm run fixture:audio:production
npm run test:integration:audio-durable-storage
npm run test:wave5a
npm run test:wave5b
```

The fixture command creates a deterministic, synthetic one-second WAV in the operating-system temporary directory and reports only its path, byte count, and SHA-256. It must be used instead of a creator-owned master for browser and recovery proof.

The deterministic local object-store proof exercises the storage adapter contract without contacting Cloudflare R2. It covers:

- private multipart initiation and upload;
- consecutive provider ETags;
- staging-to-master sealing;
- exact byte count and SHA-256 verification;
- idempotent seal retry after provider completion or staging cleanup;
- staging cleanup;
- retrieval through a new store instance;
- bucket/identity and traversal denial;
- orphaned multipart abort;
- durable cleanup receipts and local retry after provider cleanup failure;
- durable provider-operation intent, attempts, fencing, terminal resolution, and audit evidence;
- exact lost-response reconciliation for multipart initiation, parts, assembly, and cleanup;
- cleanup-versus-completion exclusion without holding database transactions across provider I/O;
- expiry and provider abort for abandoned multipart sessions;
- supported release-package MIME/signature validation and disguised-file rejection;
- unlimited release-count policy with draft attachment unable to bypass working-storage accounting;
- production rejection of the local filesystem adapter.

`npm run test:wave5a` is the local Wave 5A evidence aggregate. It runs schema consistency, the candidate contract, Collaborator Inbox behavior and static contracts, the existing ordinary file-collaboration integration on isolated embedded PostgreSQL, a mocked-browser candidate journey, the populated 0039-to-0040/0041/0042 upgrade proof, the candidate service integration on another isolated embedded PostgreSQL fixture, and a separate integration that boots the real Express application. The candidate integration exercises a creator byte ceiling, a greater-than-5-MiB two-part upload, exact part replay/conflict, post-revocation completion replay, issuing-project-authority checks through collaborator reads, grant and connection revocation access, current replacement-manager visibility, successful and failed cleanup quota transitions, cleanup-receipt immutability and terminality, candidate isolation, and bounded storage. The browser test proves fail-closed capability refresh, stale-response ordering, bounded pre-hash denial, retry, and creator retention against mocked API responses; it remains UI evidence only. The named `test:integration:collaborator-revision-http` proof separately checks the actual Express flag, authentication, exact grant/session authority, binary-parser ordering, storage non-mutation on rejected requests, durable route writes, quota-response privacy, unknown provider-error privacy, and allowlisted response DTOs; it is not a real-browser end-to-end proof.

`npm run test:wave5b` is the local Wave 5B provider-durability aggregate. It checks migration/schema consistency; runs the provider-operation contract and embedded-PostgreSQL invariant proof; verifies deterministic local and R2-adapter reconciliation; and reruns owner storage policy, ordinary file collaboration, and private candidate integration. The provider-operation proof covers immutable intent, exact subject keys, bounded leases, provider-call deadlines below the lease, heartbeat renewal until a late provider call actually settles, cross-operation cleanup fencing, attempt history, reconciliation-only recovery after started I/O, atomic domain/result finalization, dead-letter resolution, retained quota until explicit cleanup resolution, actor/grant isolation, and cleanup absence evidence. The service proofs use deterministic barriers for successful provider initiation before session finalization, successful assembly before domain finalization, a provider call that ignores cancellation beyond its original short lease, an injected transient database failure during heartbeat renewal, and an in-flight part during revocation or expiry. They assert later dispatch denial, renewed lease and attempt evidence beyond the original expiry, sessionless due-worker recovery, grant-revocation cleanup intent committed atomically with authority loss, pending cleanup receipts, provider absence, terminal mutation attempts, truthful retry-pending/in-progress cleanup results, actor-and-intent-bound owner replay, and exact quota retention/release. The separately named real-Express HTTP proof asserts that revocation during sessionless provider initiation returns `202` with pending cleanup rather than false completion. R2 adapter behavior is simulated locally; no Cloudflare request is made. This aggregate is local evidence only: it does not activate the candidate feature, push a branch, create a release, or attest a deployed build.

For an optional destructive proof against an isolated standalone local PostgreSQL database, set both required safety variables and run:

```powershell
$env:SWAY_REAL_POSTGRES_PROOF_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/sway_candidate_disposable_proof'
$env:SWAY_ALLOW_DISPOSABLE_DATABASE_RESET='true'
$env:SWAY_REQUIRE_REAL_POSTGRES_PROOF='true'
npm run test:wave5b:real-postgres
npm run test:integration:audio-candidate-revisions:real-postgres
npm run test:integration:audio-candidate-revisions:migration-upgrade:real-postgres
npm run test:integration:audio-candidate-grant-concurrency:real-postgres
```

When real-PostgreSQL proof is required, the strict scripts never select a generic `DATABASE_URL` and refuse a PGlite fallback; they attest a standalone PostgreSQL server and reset only a loopback database whose name is explicitly disposable. The candidate service proof still uses the local object-store fixture. The populated upgrade proof applies through 0039 and first proves 0040/0041 revoke and sanitize valid legacy upload authority instead of activating review access. It also seeds a valid 0040/0041 candidate grant, candidate upload session, orphan cleanup receipt, and exact session-backed cleanup receipt before applying 0042; invalid populated session identity fails the preflight before any 0042 DDL, while valid candidate authority is capped and revoked, cannot authorize intake, and both valid receipt shapes survive the new constraints. The candidate-grant concurrency proof forces two independent PostgreSQL backends behind idempotency-key, active-scope, and performer-storage advisory barriers. Exact same-key grant intent and exact candidate initiation converge on one durable result. Different grant keys for an already-active scope are rejected with a controlled 409—even when their requested intent is otherwise identical—so a successful but unrecorded alias cannot later mint fresh authority. The named Wave 5B strict aggregate runs the provider-operation contract and the same quota, idempotency, expiry, completion, provider-timeout, and heartbeat-renewal races against an attested standalone PostgreSQL server. These local scripts still do not prove a real process kill during a full service request against Cloudflare R2, a real-browser end-to-end journey, live Render secrets, recovery copy, moderation, candidate disposition/promotion, or production readiness.

Keep candidate intake disabled until the Wave 5B provider-operation candidate has verified acceptance evidence and deployed-candidate proof; a real process-kill/Cloudflare-R2 recovery run closes the remaining external durability gap; accepted files use incremental or worker-backed hashing with a server quota preflight instead of a browser whole-file read; private playback supports and tests HTTP byte ranges; and a real two-account browser journey proves upload, revocation, retained creator review, and failure recovery against the deployment candidate. Candidate-specific moderation, reporting, blocking, takedown, disposition, and promotion remain separate required slices.

## Production Evidence Gate

Use the generated, non-user-owned audio fixture from `npm run fixture:audio:production` and record:

1. deployed commit marker;
2. runtime config status showing verified R2 access;
3. proof the bucket has no public URL or custom public domain;
4. authenticated upload and seal with expected byte count and SHA-256;
5. exact authorized download with the same byte count and SHA-256;
6. service restart followed by the same exact download;
7. denial for an account without project/share authority;
8. denial after share revocation or exhaustion;
9. recovery from the separately controlled copy/export, again matching byte count and SHA-256;
10. evidence cleanup or an explicit retained-fixture record.

Never use a creator's real master as a readiness fixture. Never expose a share token, session cookie, Cloudflare credential, database URL, object key, or audio bytes in the evidence packet.

The complete-product readiness entry remains below `production_verified` until all ten items are independently recorded.

## Rollback

First set `SWAY_AUDIO_COLLABORATOR_REVISION_UPLOAD_ENABLED=false` and verify new candidate grants and uploads fail closed. Preserve the R2 bucket, credentials, multipart uploads, sealed objects, PostgreSQL candidate rows, cleanup receipts, and audit evidence.

If the Wave 5A migrations have been applied or any candidate session, candidate row, or cleanup receipt exists, do not roll the application below a compatibility build that understands those tables and continues to count candidate reservations and sealed candidates in working-storage usage. Rolling back to a pre-candidate-accounting build could create a free-storage bypass or strand cleanup state. Use flag-off containment and roll only to a compatibility build at or above that accounting floor. If the provider is unavailable or integrity/access is in doubt, disable the provider so audio routes fail closed while preserving object and database evidence.

Migrations 0040 through 0043 are forward-only. Their explicit legacy and pre-ceiling candidate-grant revocations and the 0043 provider-operation ledger are durable security evidence; disabling the flag or rolling application code does not and must not reactivate old authority or discard unresolved provider state. If collaboration is later reauthorized, a current project manager must issue a fresh bounded grant with fresh intent and a fresh idempotency key.

Do not lower `SWAY_AUDIO_WORKSPACE_LIMIT_BYTES` as an emergency deletion mechanism. Lowering it may stop new working-file reservations for performers already over the new limit, but must not remove sealed originals, cancel releases, or erase rights/takedown evidence. Restore the prior value to roll back the policy change while preserving bytes and audit state.

Credential rotation is not object deletion. Rotate the bucket-scoped token, update Render secrets, redeploy, and re-run `HeadBucket` plus exact-download verification.
