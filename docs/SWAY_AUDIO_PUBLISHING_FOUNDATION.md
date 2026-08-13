# Sway Audio Publishing Foundation

Date: 2026-07-18
Updated: 2026-08-09

## Decision

Sway is building an audio publishing and collaboration foundation for musicians, producers, engineers, comedians, podcasters, and other audio creators. The foundation defines how original files must be preserved, records project-scoped access and rights evidence, models release delivery and catalog transfers, and defines a fail-closed Continuum connector.

The current implementation includes private original-file storage and upload foundations, one-time file-pairing claims, explicit selected-version share grants, exact-original download, grant-scoped review actions, revocation, and a universal account Collaborator Inbox. It does **not** make DistroKid/DSP cutover, public playback, creator-deal execution, store delivery, sales, or royalties live. Capability flags stay false until each remaining capability has durable implementation and production evidence.

Sway still has two public sides: performer and customer. Producer, engineer, collaborator, and reviewer remain private collaboration roles, not a third public side. A collaborator may use the same authenticated Sway account without activating Pro Mode; performer authority is still required to create pairing tokens and share creator-owned files.

## Product Truth

The target customer promise will be:

> Sway preserves everything the stores allow us to preserve, verifies continuity before takedown, and tells the artist exactly what cannot transfer.

Sway must not promise that every stream, save, playlist placement, review, store URL, video view, or algorithmic association will transfer. Store behavior is outside Sway's control. A transfer is not complete merely because the replacement release is visible; Sway must verify the expected track/store matches and receive the artist's cutover approval before requesting an old-provider takedown.

Music distribution and composition publishing administration are different services. This foundation models master audio, releases, rights evidence, and delivery. It does not claim that Sway administers compositions, registers works, collects publishing royalties, or satisfies interactive-streaming licensing obligations.

## Lossless Master and Collaboration Invariants

An accepted original asset version is immutable evidence. Sway must:

- store original bytes in private versioned object storage, never in the application container filesystem;
- record the storage provider, bucket, object key, byte count, MIME type, SHA-256 digest, and available audio properties;
- keep release count unlimited while enforcing a configurable per-performer working-storage pool (5 GiB by default) and working-file record safeguard (10,000 by default) over active upload reservations and sealed files that are not named in an immutable, validated release-package manifest;
- treat draft attachment and rights-review state as working storage, so a creator cannot turn arbitrary storage into exempt bytes merely by creating release drafts;
- expire abandoned multipart sessions and reject unsupported or obviously disguised upload content before it can become a sealed original;
- verify uploaded bytes against the expected byte count and SHA-256 digest before sealing a version, and bind the sealed row to its upload session, verifier, verification timestamp, and non-empty evidence;
- preserve the exact accepted bytes for original download;
- create a new immutable version when a collaborator uploads a revision instead of overwriting the prior version;
- store previews, waveforms, transcripts, thumbnails, Continuum sources, and Continuum renders as derivatives linked to their source version;
- never substitute a transcoded preview for an original download;
- quarantine or reject a file that fails integrity, malware, format, or policy checks;
- authorize every upload, download, comment, approval, share, and release action against durable project-scoped access.

"Lossless" means a recipient authorized to download the original receives bytes whose SHA-256 digest matches the accepted source version. It does not mean that every browser preview is lossless; previews may be derivatives and must be labeled as such.

Resumable upload sessions are idempotent. A session records expected size and digest, provider upload identity, part size, parts, expiry, and completion. Completing the same session twice must not create two asset versions.

## Private File Connections and QR Pairing

The required file-pairing QR flow is separate from Sway's static room QR. Private file-pairing QR routes are live for one-time connection claims; selected-file access grants after pairing remain explicit and are not granted by pairing alone. The behavior below defines the pairing invariants.

| QR | Scope | Reuse | Result |
| --- | --- | --- | --- |
| Room QR | Public `/g/{gigId}` live room | Reusable while that room is shared | Opens Request, Tip, and Boost |
| Request-files QR | Private account pairing | Token may be claimed once | Records that the creator is requesting files; it does not grant the scanner Catalog upload/share authority |
| Send-files QR | Private account pairing | Token may be claimed once | Records that the creator intends to share selected files with the scanner; pairing itself transfers nothing |

The one-time rule applies to the QR claim, not to the resulting connection. A successful claim creates a private connection that remains available until either participant removes it. It is not tied to a gig or room. The pairing purpose records request/send direction as provenance only. It does not let an ordinary account upload or send from a creator Catalog; each later selected-file share requires performer authority and remains an explicit action. A file connection does not grant access to every project, asset, master, or release; each share or project grant remains explicit and least-privileged.

Required pairing behavior:

1. The creator chooses `request_files` or `send_files`.
2. The authenticated client creates a 256-bit secret with Web Crypto, submits only its SHA-256 hash plus a client request ID, and retains the raw secret only long enough to render the short-lived QR. The server never stores or echoes the raw claim secret.
3. The QR uses the dedicated `/account/collaboration/connect#token={opaque-token}` path, with the opaque token in its URL fragment, separate from the static `/g/{gigId}` room path. The fragment is not sent automatically in the HTTP request or referrer; after authentication and confirmation, the client submits the token in an authenticated POST body. The URL contains no email address, storage key, project secret, or room identifier.
4. The authenticated scanner sees the signed-in account display name or email, the creator identity, pairing purpose, and direction before confirming.
5. The server must atomically claim the unused token and create the connection or return the already-active connection for the same two people. A previously removed connection must never be silently restored.
6. The claim fails closed if the token is expired, consumed, revoked, malformed, or scanned by its creator.
7. Token creation, claim, replay denial, connection creation, and revocation are auditable events.

Required connection behavior:

- a connection identifies both user accounts and records who initiated it;
- the pairing purpose is retained as connection provenance and does not itself transfer a file;
- each later selected-file share, review, or revocation is an explicit, authorized, auditable action;
- either participant can revoke the connection immediately;
- revocation blocks new sends and requests but does not delete immutable transfer/audit evidence;
- reconnecting requires a new one-time pairing token;
- room membership, performer profile visibility, and file connection status never imply one another;
- unauthenticated scanners may be asked to sign in, but token consumption occurs only after authentication and confirmation.

`audio_file_connections`, pairing-token records, and append-only connection events are the durable pairing boundary. The UI QR only transports the one-time claim secret and never becomes an authorization boundary by itself.

### Selected-file access after pairing

Pairing alone grants no project or file access. In the current selected-file runtime, a performer-authorized creator can share one immutable asset version with one connected account. Sway creates an `audio_file_access_grants` record for that version and grantee. The grant records its permissions independently and may expire or be revoked; the Collaborator Inbox exposes exact-original download, review notes/change requests, and approval only when the corresponding grant permission allows the action.

Sharing references the selected version's existing storage identity and SHA-256 digest. It does not copy, relocate, rename, or transcode the original object. Revoking access removes the recipient's authorization without deleting the original or its audit evidence. Sharing a project, a different version, or another file requires its own explicit grant.

Working-storage accounting is separate from release capacity and long-term master retention. Active upload reservations and unqualified sealed versions consume the configured per-performer pool. A file version is excluded only when Sway appends an immutable manifest containing its exact version ID, hash, byte size, and release role after independent readiness validation. A future delivery integration must append the same exact manifest from its coupled, immutable provider-submission event; changing a release or delivery status alone never graduates bytes. Each recording contributes one exact master role, the release contributes one artwork role, and only the latest independently verified rights document per declaration scope may appear. Superseded, rejected, revoked, merely proposed, later-attached, and provisional creator-deal documents remain working storage. The immutable manifest continues to preserve its exact package through takedown. This prevents quota graduation from becoming a document-dump bypass while keeping release count unlimited. The exclusion does not delete, move, publicize, or prove delivery of the file. Sway does not automatically delete sealed originals to make room; takedown, dispute, legal-retention, and recovery evidence remain preservation concerns, and a restriction or legal hold by itself does not reward an account with additional working capacity.

Before appending that manifest, the server reopens the exact sealed objects. A recording master must parse as playable audio with matching container, codec, positive duration, sample rate, and channel count; RIFF/FORM media must end at its declared container boundary. Artwork must decode as its declared image type and end at the strict PNG, JPEG, GIF, or WebP boundary. Rights evidence is capped at 10 MiB and must be valid UTF-8 text/Markdown or a complete paged PDF without embedded files, portfolios, scripts, or launch actions. Per-file release eligibility is capped at 4 GiB for a master and 50 MiB for artwork. These are release-asset eligibility controls, not a release-count limit or a malware-scanning claim.

### Universal Collaborator Inbox

`/account/collaboration` is the authenticated Collaborator Inbox for any Sway account; it does not require a performer profile, Pro Mode, payout readiness, or an active live room. It lists the account's private connections plus files shared with and by that account. Within an active grant, the UI and server enforce the selected download, comment/change-request, and approval permissions. Pairing does not add a Catalog or send control for an ordinary account. Either participant can remove a connection, and an authorized grant participant can revoke selected-file access. Review history is scoped to the selected grant rather than inferred from the asset version alone.

`/account/collaboration/connect` is the canonical pairing-claim route. Its ready confirmation names the signed-in account by display name or email before that account irreversibly consumes the one-time claim. The legacy `/talent/connect/files` entry performs a client-side replacement so the private fragment survives without moving into a query string. An unauthenticated scanner uses `/account/login?next=/account/collaboration/connect` while the raw token remains only in the URL fragment; account creation requires verification followed by a fresh scan rather than persisting the secret in a query, log, email link, or browser storage.

This inbox slice reuses the existing connection, pairing-token, selected-file grant, review-event, and audit boundaries. It adds account-universal routing, authorization, and UI; it introduces no new schema or migration and no distribution fee, sale, royalty, payout, Stripe, or live-room money behavior.

## Catalog Transfer Contract

Catalog transfer follows one controlled state machine:

```text
intake
  -> source_snapshot
  -> rights_review
  -> artist_identity_mapped
  -> parity_locked
  -> new_delivery_staged
  -> store_processing
  -> overlap_live
  -> store_match_verified
  -> artist_cutover_approved
  -> old_provider_takedown
  -> cutover_monitoring
  -> tail_royalty_reconciliation
  -> complete
```

Hold states are:

```text
rights_blocked
parity_failed
mapping_failed
track_link_failed
content_id_conflict
revenue_gap
```

`canceled` is a terminal administrative exit before old-provider takedown; cancellation never represents a completed migration. Any hold blocks old-provider takedown. A database trigger validates every status edge, requires an authenticated actor and reason, and appends the transition event in the same transaction. A hold may resume only with fingerprinted resolution evidence. Store-match verification requires complete non-empty release and recording manifests plus one sealed continuity fingerprint; child evidence is frozen after that point. Artist approval must match that fingerprint. Old-provider takedown additionally requires zero unresolved holds, the exact approval fingerprint, an atomically recorded takedown request, and matched release- and recording-level continuity.

Before `parity_locked`, preserve and compare at least:

- existing ISRCs, UPC/EAN/JAN/GRid values, source distributor IDs, and destination IDs/URLs;
- exact audio bytes and digest, duration, codec, sample rate, bit depth, channels, filename, and version;
- title, version title, casing, artist spelling/order/roles, track/disc order, explicit flag, languages, release dates, genre, label, and territories;
- P and C lines, master owner, writers, composers, publishers, credits, splits, licenses, sample/beat/cover evidence, and disputes;
- artwork and digest, lyrics/timed lyrics, video, motion/spatial assets, and available platform-specific assets;
- baseline store presence, play counts, saves, playlists, reviews, Content ID state, and other observable continuity evidence;
- royalty statements, withdrawals, pending balances, recoupments, and other source-provider financial records supplied by the artist.

Do not combine a migration with a remaster, rebrand, title change, artist-name change, artwork replacement, or track-order change. First deliver frozen parity using the same eligible audio, metadata, identifiers, and artist mappings. Make creative changes only after continuity is verified.

The old provider remains active during the overlap window. Sway may enter `old_provider_takedown` only after all required releases have a verified overlap/store match, known limitations are disclosed, and the artist has explicitly approved cutover. Delayed source-provider royalties remain subject to tail reconciliation; the artist must not be told to close the old account prematurely.

Catalog cutover automation remains disabled in this slice. Before any runtime may request a real takedown, each continuity report must also be bound to immutable delivery/provider event evidence for the intended destinations. The schema state machine is a safety foundation, not proof that a store accepted, linked, or kept a release live.

## Release and Delivery Boundary

The model supports these intended release modes:

- `private`: collaboration and review only;
- `sway_only`: eligible release published only through a future Sway playback/publication service;
- `sway_first`: eligible release debuts in Sway before later external delivery;
- `everywhere`: eligible release submitted through an approved delivery provider to selected destinations.

These are intent states, not proof of a working delivery channel. No release becomes published merely because its desired mode is stored. Publication requires verified masters, cleared rights, delivery acceptance, destination evidence, and any licensing required for the actual playback or store use.

The future delivery runtime must create a clean draft under active release-management authority. Every status change must carry an authenticated actor, reason, unique idempotency key, and—when provider evidence changes—a payload fingerprint; the database appends the corresponding status event in the same transaction and assigns lifecycle timestamps itself. Provider callbacks must preserve the provider event ID and payload SHA-256 under verified service context. Submitted deliveries require a frozen metadata fingerprint and provider release ID; accepted and live states additionally require a destination release ID and an immutable provider-callback event for the exact transition payload. Delivery evidence and events are append-only audit inputs, not permission to claim that an external store is integrated or live.

Initial external delivery should use an established distribution platform with a written commercial and technical agreement. Direct Spotify or Apple delivery is not assumed. Provider choice, pricing, deductions, payout ownership, reserves, termination, export, takedown, sandbox access, and service levels must be agreed before runtime integration.

Reference material:

- Spotify provider directory: https://artists.spotify.com/providers
- Apple distribution guidance: https://artists.apple.com/support/1108-get-your-next-release-on-apple-music
- Spotify re-upload guidance: https://support.spotify.com/us/artists/article/re-uploading-music/
- IFPI ISRC guidance: https://isrc.ifpi.org/faqs
- YouTube distributor migration behavior: https://support.google.com/youtube/answer/12732257?hl=en
- U.S. Copyright Office on compositions versus sound recordings: https://www.copyright.gov/register/pa-sr.html
- U.S. Copyright Office on Section 115 digital phonorecord deliveries: https://www.copyright.gov/music-modernization/115/
- 15 U.S.C. 7001 on electronic records and signatures: https://uscode.house.gov/view.xhtml?edition=prelim&num=0&req=granuleid%3AUSC-prelim-title15-section7001

## Continuum Connector Boundary

Continuum is a connector for source manifests, embeds, source/package download, derivative planning, and future portable media exchange. It is not Sway's master vault, rights ledger, user/permission system, audio player, store distributor, or sales ledger.

The initial Continuum capability snapshot is fail-closed:

| Capability | Initial value |
| --- | --- |
| Hosted source manifest | true |
| Embed player | true |
| Source download | true |
| Derivative planning | true |
| Lossless binary master storage | false |
| Resumable multipart upload | false |
| Durable account permissions | false |
| Private collaboration | false |
| Audio playback | false |
| External DSP delivery | false |
| Direct sales | false |

When the storage slice is implemented, Sway—not Continuum—will operate private storage and become the system of record for original asset identity, object references, checksums, project permissions, rights evidence, release state, delivery state, transfer state, and audit history. Creators retain ownership of their audio and underlying works. A Continuum link stores the external source identity and the capability snapshot observed when linked. Missing or unknown capabilities evaluate to false. Connector failure cannot mutate or delete the immutable original.

## Money, Sales, and Royalty Truth

Under the target model, Sway is FlavorGood Marketing's distribution product. Sway will not acquire a creator's master copyright, composition copyright, producer rights, or creator-to-creator revenue share. A creator will grant Sway only the limited, non-exclusive authority stated in the versioned distribution agreement for the selected release, destinations, territories, and term. The distribution fee is a service charge, not copyright ownership or label points.

The target workflow will let artists, producers, writers, engineers, comedians, and other collaborators propose and accept deals among themselves through Sway. Each proposed deal version is cryptographically bound to one immutable terms document; every acceptance or rejection is bound to that exact digest, an authenticated actor, a named account party, and non-empty authentication evidence. Parties and structured allocations become immutable once invitation activity begins, and events are append-only. An amendment creates a new version instead of rewriting signed evidence. Creator-deal execution remains disabled until legal review is complete and a later seal binds the terms, parties, allocations, and signature ceremony into one package fingerprint; Sway must not yet present these records as legally effective or decide ownership for the parties.

The owner-set distribution fee is locked per paid audio line item:

- sale price below $5.00: 20% of the price, rounded down to the cent in the creator's favor;
- sale price of $5.00 or more: a flat $1.00;
- separately stated tax is outside the fee base;
- a refunded sale reverses the corresponding Sway distribution fee.

Examples: a $1.00 item produces a $0.20 Sway fee, a $4.99 item produces a $0.99 fee, a $5.00 item produces a $1.00 fee, and a $20.00 item still produces a $1.00 fee. Processor fees, taxes, reserves, chargebacks, and creator allocations are separate line items and must be disclosed rather than hidden inside Sway's fee.

This foundation records the fee policy and provisional creator-deal evidence but does not yet charge for downloads, sell releases, execute creator agreements, calculate royalties, allocate collaborator money, collect mechanical or performance royalties, or create payouts. A later sales/royalty slice requires a separate append-only ledger, idempotent order/payment lifecycle, contract-versioned split instructions, statement imports, reconciliation, KYC/tax handling, audit records, and explicit customer copy. It must not reuse Sway's live-room tip/request/boost payment records.

Sway's existing live-room revenue and future merch fulfillment, ticketed shows, and paid streams are separate revenue lanes with separately disclosed terms. No lane may silently stack a fee onto another.

## Correct Build Order

1. Apply and verify the schema in a non-production database.
2. Select private versioned object storage and define retention, encryption, malware scanning, and restore behavior.
3. Build authenticated project access plus resumable upload and exact-byte download routes.
4. Build one-time request/send pairing claims, revocable private file connections, and explicit selected-version shares. (implemented in the current runtime and universal Collaborator Inbox)
5. Continue the broader immutable-version and derivative workflows. Selected-file download, grant-scoped review/approval, and revocation are implemented; collaborator revision upload and wider project workflows remain incomplete.
6. Build rights declarations, immutable creator-deal versions, authenticated acceptance evidence, and release-readiness checks after legal review.
7. Build catalog intake, parity comparison, transition enforcement, overlap verification, and artist cutover approval.
8. Contract with and integrate one external delivery provider.
9. Build Sway-only playback/publication only after licensing, moderation, reporting, and takedown requirements are satisfied.
10. Add sales and royalty accounting as its own money-safe slice, applying the locked $1/20% distribution fee without reusing live-room money records.

No UI may claim a step is live before its server route, durable persistence, access boundary, failure behavior, audit trail, and production evidence exist.
