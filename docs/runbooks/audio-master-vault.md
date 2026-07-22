# Audio Master Vault Deployment and Recovery

This runbook governs Sway's exact-original private audio storage. A merged blueprint, successful deploy, configured path, or passing local test is not proof that production masters are durable.

## Current Architecture Boundary

The current provider is a private filesystem on one Render persistent disk:

- disk mount: `/var/data/sway-audio`
- object root: `/var/data/sway-audio/objects`
- logical bucket: `sway-audio-originals`
- sealed object: one immutable `original.bin` per asset-version storage key
- integrity: expected byte count and SHA-256 must match before the original is sealed

The server verifies `/proc/self/mountinfo` at startup. In production, a configured audio provider with a missing or false mount fails startup instead of silently serving an ephemeral vault.

This is a single-service storage boundary. It does not prove horizontal scaling, multi-region durability, provider-independent backups, or DistroKid-scale capacity. Those remain architecture and operational decisions before general availability.

## Render Preconditions

Before merging or applying the blueprint:

1. Confirm the existing `sway-tips-web` service is on a Render plan that supports persistent disks.
2. Confirm the account owner accepts the disk charge, single-instance constraint, and brief deploy downtime associated with a disk-backed service.
3. Confirm the active Render service is managed by this repository's Blueprint. `render.yaml` in Git is intent, not proof that the live service consumed it.
4. Attach the disk without detaching or deleting any prior audio disk. Disk deletion is destructive and is not part of application rollback.

## Required Runtime Configuration

```text
SWAY_AUDIO_STORAGE_PROVIDER=local_private_fs
SWAY_AUDIO_LOCAL_OBJECT_DIR=/var/data/sway-audio/objects
SWAY_AUDIO_LOCAL_BUCKET=sway-audio-originals
SWAY_AUDIO_LOCAL_DURABLE_MOUNT=true
SWAY_AUDIO_LOCAL_MOUNT_PATH=/var/data/sway-audio
```

`GET /api/runtime-config-status` must report both `audioStorage.enabled: true` and `audioStorage.durableMountVerified: true`. The endpoint intentionally does not expose filesystem paths.

## Evidence Gate

Run the local deterministic proof first:

```powershell
npm run test:integration:audio-durable-storage
```

It proves exact-byte sealing and retrieval after store reinitialization, checksum rejection, identity denial, traversal denial, and mount verification. It does not prove the live disk or recovery process.

Production evidence must use a non-user-owned deterministic fixture and record:

1. deployed commit marker;
2. runtime storage status with the durable mount verified;
3. authenticated upload, seal response, expected byte count, and expected SHA-256;
4. exact download byte count and SHA-256;
5. service restart followed by the same exact download;
6. denial for an account without project/share authority;
7. denial after share revocation or exhaustion;
8. recovery from a Render disk snapshot into an isolated recovery service or replacement disk, followed by the same exact download and SHA-256;
9. evidence cleanup or an explicit retained-fixture record.

Never use a creator's real master as a readiness fixture. Never expose a share token, session cookie, object path, database URL, or audio bytes in the evidence packet.

The complete-product readiness entry remains below `production_verified` until all nine items are independently recorded.

## Rollback

Rollback the application commit while leaving the disk attached and unchanged. Do not delete, detach, reformat, or repoint the disk as an application rollback step. If the new server rejects the mount, preserve the failed deploy logs and existing disk, restore the prior application version, and investigate the configuration mismatch before retrying.

If storage integrity or authorization is in doubt, disable new audio uploads and downloads fail-closed while preserving the disk and database evidence.
