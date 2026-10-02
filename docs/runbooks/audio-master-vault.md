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

PostgreSQL remains authoritative for projects, ownership, access grants, upload sessions, immutable asset-version identity, checksums, rights evidence, and audit history. R2 contains only opaque object keys and bytes. The bucket must remain private; never enable an `r2.dev` URL or public custom domain for the master bucket.

The vault is not an unlimited general-purpose file locker. PostgreSQL calculates a per-performer working-storage balance from active multipart reservations and sealed versions that are not named in an immutable, validated release-package manifest. The default pool is 5 GiB with at most 10,000 working-file records, preventing both byte-volume and tiny-object abuse. Release count is unlimited. Exact package versions graduate from working-pool accounting without moving or deleting their immutable objects; a mutable release or delivery status, a later attachment, or a provisional document never grants that exemption.

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

## Optional Neon Preview Adapter

`render.yaml` continues to select R2. The optional `neon` provider requires a separately provisioned **private** bucket on an isolated Neon branch, with its database and storage endpoint bound to that same branch. This adapter does not create buckets, change production configuration, copy existing R2 files, or grant access to them.

Set only on that isolated preview:

```text
SWAY_AUDIO_STORAGE_PROVIDER=neon
SWAY_AUDIO_NEON_BUCKET=<private preview bucket>
AWS_ENDPOINT_URL_S3=<HTTPS branch storage endpoint origin>
AWS_REGION=<branch storage region>
AWS_ACCESS_KEY_ID=<branch-scoped storage credential>
AWS_SECRET_ACCESS_KEY=<branch-scoped storage secret>
```

The existing AWS S3 SDK supplies SigV4 and path-style addressing; the adapter disables optional SDK request checksums as recommended by Neon's quickstart. No new SDK or signing implementation is introduced. Neon completes multipart uploads directly to a private `masters/` key and reads back the bytes to verify size and SHA-256 before the existing database transaction can seal a version. It does not rely on `CopyObject`, which Neon's current compatibility reference does not list. Failed verification uses the existing failed-upload cleanup path to delete that unsealed target. Successful retry never deletes a sealed Neon master. R2 retains its existing staging-and-copy behavior.

To retain access to R2 identities in a preview, also set `SWAY_AUDIO_STORAGE_READ_PROVIDERS=r2` and supply **read-only R2 credentials** for the matching legacy bucket. Never clone writable production R2 credentials into a preview. New uploads go to Neon; original reads use the provider and bucket persisted in PostgreSQL. Every mutation of a non-primary provider—including upload writes, completion, abort, and failed-object deletion—is rejected before transport. Existing pending R2 uploads must finish in the unchanged R2 production application; this preview is not an upload migration facility. Register only backends deliberately needed by that environment. Each registered backend must pass startup readiness. A missing backend, different bucket, storage error, or missing object fails closed; none retries against a different provider. A Neon branch does **not** isolate external R2 bytes. No credentials are created or copied by this change.

All downloads continue through Sway's existing ownership, grant, revocation, expiry, use-count, and audit checks. The adapter does not expose anonymous object URLs or add presigned URLs. `HeadBucket` proves reachability only; verify private access independently before live preview proof. Neon versioning and lifecycle configuration are not enforced according to its compatibility reference, so neither is a recovery or retention control.

Use the existing generated non-user-owned WAV and the ten production-evidence controls below in the isolated preview, recording the actual branch and commit. Until that provider proof exists, deterministic SDK mocks establish adapter behavior only, not live Neon durability, bucket privacy, credentials, recovery, or operational readiness. Selecting R2 again is safe only while Neon rows remain routed by `SWAY_AUDIO_STORAGE_READ_PROVIDERS=neon`; removing a configured backend does not move its files. An application rollback to code without Neon support must use a database/environment without Neon identities or leave those identities unavailable while preserving their bytes.

Official sources checked 2026-09-17: [Neon storage quickstart](https://neon.com/docs/storage/get-started), [S3 compatibility](https://neon.com/docs/storage/s3-compatibility).

## Automated Evidence

Run:

```powershell
npm run fixture:audio:production
npm run test:integration:audio-durable-storage
```

The fixture command creates a deterministic, synthetic one-second WAV in the operating-system temporary directory and reports only its path, byte count, and SHA-256. It must be used instead of a creator-owned master for browser and recovery proof.

The deterministic R2-compatible proof covers:

- private multipart initiation and upload;
- consecutive provider ETags;
- staging-to-master sealing;
- exact byte count and SHA-256 verification;
- idempotent seal retry after provider completion or staging cleanup;
- staging cleanup;
- retrieval through a new store instance;
- bucket/identity and traversal denial;
- orphaned multipart abort;
- atomic working-storage reservations under concurrent upload starts;
- expiry and provider abort for abandoned multipart sessions;
- supported release-package MIME/signature validation and disguised-file rejection;
- unlimited release-count policy with draft attachment unable to bypass working-storage accounting;
- production rejection of the local filesystem adapter.

It does not prove the live Cloudflare account, live Render secrets, recovery copy, or customer authorization path.

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

Rollback the application commit without deleting the R2 bucket, credentials, multipart uploads, or sealed objects. If the provider is unavailable or integrity/access is in doubt, disable the provider so audio routes fail closed while preserving R2 and PostgreSQL evidence.

Do not lower `SWAY_AUDIO_WORKSPACE_LIMIT_BYTES` as an emergency deletion mechanism. Lowering it may stop new working-file reservations for performers already over the new limit, but must not remove sealed originals, cancel releases, or erase rights/takedown evidence. Restore the prior value to roll back the policy change while preserving bytes and audit state.

Credential rotation is not object deletion. Rotate the bucket-scoped token, update Render secrets, redeploy, and re-run `HeadBucket` plus exact-download verification.
