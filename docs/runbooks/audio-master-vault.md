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
```

The three credential values are declared `sync: false` in `render.yaml`; Git never contains them. They must be installed in the live Render service's secret environment.

`GET /api/runtime-config-status` must report:

```json
{
  "audioStorage": {
    "enabled": true,
    "provider": "r2",
    "objectStorageVerified": true
  }
}
```

The endpoint intentionally exposes no account ID, bucket name, key, secret, object path, or user data.

## Automated Evidence

Run:

```powershell
npm run test:integration:audio-durable-storage
```

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
- production rejection of the local filesystem adapter.

It does not prove the live Cloudflare account, live Render secrets, recovery copy, or customer authorization path.

## Production Evidence Gate

Use a generated, non-user-owned audio fixture and record:

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

Credential rotation is not object deletion. Rotate the bucket-scoped token, update Render secrets, redeploy, and re-run `HeadBucket` plus exact-download verification.
