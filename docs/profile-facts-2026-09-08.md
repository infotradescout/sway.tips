# Four public professional profiles — 2026-09-08

This records the evidence and rollback contract for `0051_friend_public_profiles.sql`. The user expressly authorized accurate public professional pages for Bubba Khain, Callie Hines, Corey Mack and Drew Maze. This operator publication does not assert that the four people completed account claiming, email verification, terms acceptance, onboarding, KYC or a payment setup.

## Policy and scope

`src/server/public-profile.ts` permits an existing owned, active performer with public visibility and valid identity to resolve while `onboarding_status` remains `created`. It rejects restricted/suspended status. `server.ts` additionally requires a nonempty bio for public discovery. No onboarding transition is needed for these four pages.

The governing `PUBLIC_DISCOVERY_CONTRACT_V1.md` permits owner-claimed **or system-verified public intent**, requires accurate facts and permanent identity, and excludes private information. The explicit user authorization supplies the public intent here. Publication is an operator act, not a fabricated owner act: the audit uses `actor_type = operator` and a null actor UUID rather than impersonating a user.

This migration updates only performer `bio`, `is_active`, `visibility_state` and `updated_at`; inserts a new public profile and reviewed links; and appends one audit event per published identity. It leaves previews intact, including their unrelated metadata. It neither updates an existing public profile nor overwrites any existing profile metadata. Accounts, credentials, contacts, verification, terms, onboarding, payment/KYC, room state, partner benefits and invitations are outside its write set. EdgeWize and both DJ3X identities are outside the target list.

## Reviewed identity baseline

A read-only operator snapshot supplied on 2026-09-08 established these exact existing identities. Each performer had null bio, `is_active = false`, `visibility_state = draft`, `onboarding_status = created`, no public-profile row and zero profile links. Each active preview was linked to its performer, used the exact professional display name below, and had metadata exactly `{"stageName":"<display name>"}`.

| Handle | Display name | Performer UUID | Owner UUID | Preview UUID |
| --- | --- | --- | --- | --- |
| bubbakhain | Bubba Khain | b1b0e4d9-d4a8-4526-b49a-f5c4e464cfcd | 87b3512f-a5a6-4b1f-b80b-1a94f9575a98 | 34607bf4-37ca-43d5-b61f-3d684a410e32 |
| calliehines | Callie Hines | ed8116ce-8255-4ff8-bfec-6a57ec9568cf | 7e78b206-060e-4fed-bb77-6d45113a3b4b | 51e64828-fc4d-4e60-a743-afd993674141 |
| coreymack | Corey Mack | da855e85-9f7a-469e-9d9d-8c8e1ce20b96 | e66685f1-885b-47c0-ac05-a4cf1e623087 | 59a1b6cf-854e-47f2-aa8f-d1424abe868c |
| drewmaze | Drew Maze | bc1c60c2-2ec1-4967-ad2f-b099adfcbb7c | bb5a762c-4a0f-47c2-bba9-bb83590764e9 | d834d8c0-3374-4ec9-bea8-93419fd6df0e |

The migration checks exact UUID linkage, case-normalized canonical handle ownership, display names, active previews, preview metadata, original image URL, untouched draft state, absent public content, and absence of a previous profile/visibility save audit. It refuses a restricted or revoked owner, an active owner block, or a latest moderation decision other than allowed for the owner, performer or preview. Any unexpected present identity/state raises an exception, rolling back the entire SQL statement; do not remove guards to make a failed migration pass.

If none of a target's performer UUID, preview UUID, handle or handle claim exists, that target is skipped. Fresh installations create no people, users or previews. A successful publication audit with `migrationId = 0051_friend_public_profiles_v1` makes retries a no-op even after a later owner edit, unpublication or rollback. No automatic retry republishes a page.

## Public facts and destinations

| Person | Facts included | Exact supporting sources |
| --- | --- | --- |
| Bubba Khain | Hip-hop artist; four-track EP *1,040 Degrees*; *Major* and *FAKE LOVE* feature Drew Maze. | [Apple Music artist](https://music.apple.com/us/artist/bubba-khain/1450529807), [Audiomack artist](https://audiomack.com/bubba-khain), [Audiomack EP](https://audiomack.com/bubba-khain/album/1040-degrees), [Major](https://audiomack.com/bubba-khain/song/major), [FAKE LOVE](https://audiomack.com/bubba-khain/song/fake-love) |
| Callie Hines | Louisiana singer-songwriter and acoustic guitarist; Americana/folk with bluegrass/country influences; six-track debut EP *Tell Me Why I've Come Home*. | [OffBeat review](https://www.offbeat.com/music/callie-hines-tell-me-why-ive-come-home-ep/), [Spotify artist](https://open.spotify.com/artist/2xxnkOlnJBeYGnxkcK5O5g), [Spotify EP](https://open.spotify.com/album/2OPIiznw7NwXxvyjJaCNro) |
| Corey Mack | Stand-up, beatboxing, DJ, MC/event hosting; public name *The Jester of Sound and Soul*; booking destination. | [Official site](https://coreymack.us/), [opening-set video](https://www.youtube.com/watch?v=_KzoiR1RgrU) |
| Drew Maze | Released recordings *Dead People*, *The Honorable*, *Mutual*; collaborations with Bubba Khain on *Major* and *FAKE LOVE*. | [Apple Music artist](https://music.apple.com/us/artist/drew-maze/1528296799), [Major](https://music.apple.com/us/album/major-feat-drew-maze-single/1760366176), [FAKE LOVE](https://music.apple.com/us/album/fake-love-feat-drew-maze-single/1760798094) |

The Apple Music, Audiomack, OffBeat and Corey official-site pages were read directly. Callie's exact Spotify artist/EP destinations and Corey's video identity/title were corroborated through indexed public search results; automated direct reads were unavailable. Metadata records this distinction as `public_page` versus `search_index`, without claiming successful playback.

Callie's [Instagram identity](https://www.instagram.com/thecalliehines/) is linked by OffBeat. The [FOX10 interview listing](https://www.fox10tv.com/2023/03/24/chatting-with-callie-hines/) corroborates both that Instagram identity and [Facebook](https://www.facebook.com/thecalliehines/). The direct social pages were unavailable to automated reading, so these are cross-source identity checks, not account access.

**User-confirmed, not independently web corroborated:** Drew Maze is a rapper and producer and owns Lo-Ram Studios, described by the user as a new record label. This fact is included at the user's direction and separately attributed under `profileProvenance.userConfirmedFacts`. Do not infer founder status, a founding year, roster, physical studio, business address, available services or prices. The time-sensitive word “new” should be reviewed during future profile maintenance.

No current city is copied from a preview. No live availability, schedules, audience figures, award claims, private contacts, career start dates or personal biography is added. Bubba's EP year is omitted because catalog metadata is inconsistent for one track. Corey's video is an opening set associated with Theo Von's *No Offense*; it does not establish that Corey has a Netflix special or appears in its released cut.

The migration does not copy any preview's featured videos. The verified Corey clip is a normal external watch link; all new `featured_media` arrays are empty. The other supplied Spotify, Apple, SoundCloud, YouTube and social destinations whose identity could not be sufficiently checked are omitted rather than copied wholesale.

## Existing public images

The operator snapshot identified these already-curated public images; the migration requires an exact match and copies the linked preview's URL. It does not replace or download an image.

| Person | Existing image |
| --- | --- |
| Bubba Khain | [bubba-khain-avatar.jpg](https://sway.tips/assets/bubba-khain-avatar.jpg) |
| Callie Hines | [callie-hines-avatar.jpg](https://sway.tips/assets/callie-hines-avatar.jpg) |
| Corey Mack | [Corey Mack public image](https://img1.wsimg.com/isteam/ip/507cdd9e-ba65-48f1-ac5c-290e6c33023b/72E6855B-ABEB-492D-8EA4-0DAB48CAA65E.jpeg) |
| Drew Maze | [drew-maze-avatar.jpg](https://sway.tips/assets/drew-maze-avatar.jpg) |

## Audit and rollback

Each `performer_public_profile.operator_publish` audit records internal identity UUIDs, the original performer fields, the complete inserted profile and links including generated UUIDs/timestamps, and the exact post-publication performer fields. It contains no account credential, email, phone, terms or payment snapshot. Audit events and source previews are never removed or rewritten.

Identify the exact publication records with this read-only query:

```sql
SELECT event_id, entity_id, metadata->'identity' AS identity,
       metadata->'before' AS before_snapshot,
       metadata->'after' AS after_snapshot
FROM audit_events
WHERE actor_type = 'operator'
  AND entity_type = 'performer'
  AND event_type = 'performer_public_profile.operator_publish'
  AND metadata->>'migrationId' = '0051_friend_public_profiles_v1'
ORDER BY metadata->'identity'->>'handle';
```

Rollback is a separately reviewed operator transaction, scoped to the returned event IDs, with these exact preconditions and mutations:

1. Take the same transaction advisory lock using `pg_advisory_xact_lock(hashtextextended('0051_friend_public_profiles_v1', 0))`. Lock each matching performer, profile and links with `FOR UPDATE`, in handle order. Require the performer UUID, owner UUID and normalized handle to match `metadata.identity`. Require no prior rollback audit for the selected publication event ID.
2. Build the current performer object with exactly `bio`, `is_active`, `visibility_state`, `updated_at`, as in the migration. Compare it using `IS NOT DISTINCT FROM` against `metadata.after.performer`. Compare `to_jsonb(current_public_profile)` against `metadata.after.publicProfile`. Compare `coalesce(jsonb_agg(to_jsonb(link) ORDER BY sort_order, id), '[]'::jsonb)` against `metadata.after.links`. Abort the entire rollback if any identity, value, timestamp, link or profile differs. That is a later edit requiring a new, narrow repair; it must not be erased by snapshot restoration.
3. After every selected event passes the checks, delete only its inserted link UUIDs from `metadata.after.links`, scoped to its performer UUID. Delete its newly inserted public profile, again requiring equality with `metadata.after.publicProfile`. Restore `bio`, `is_active` and `visibility_state` from `metadata.before.performer`; set `updated_at = clock_timestamp()` to record the rollback as a new mutation. No onboarding, user, preview, moderation, payment or unrelated metadata change is part of rollback.
4. Append an `actor_type = operator`, `event_type = performer_public_profile.operator_publish_rollback` audit for each performer, recording `publicationEventId`, the migration key, the current pre-rollback snapshot, restored fields and the operator's reason. Retain the original publication event, so replay of 0051 remains a no-op. Commit all selected reversals atomically.

If an emergency requires hiding a page that has since been edited, do not relax the snapshot comparison. Use the normal separately authorized visibility control for that exact performer and preserve the edited content; prepare a new repair if needed.

## Verification handoff

This artifact is migration source, not evidence of production publication. The root implementation owns journal registration, integration proof, independent Objector review and release/browser verification. Required migration proof cases: empty database no-op; four exact identities publish; repeat no-op; post-publication edits survive repeat; wrong UUID/owner/claim/preview/name/image or draft state aborts; existing profile/links/save audit aborts; owner suspension/block and latest moderation hold/block abort; all-four transaction rolls back when one guard fails; account, onboarding, payment, preview and unrelated rows remain byte-for-byte unchanged; rollback succeeds only against the unchanged audited after-state.

Worker gate attempts on 2026-09-08: `npm run lint`, `npm run build` and `npm run test:contracts` were each stopped by the execution environment before starting, with “network approval was cancelled before a decision was returned.” These are not passing checks. Static inspection confirmed the four-table write allowlist and absence of user, preview, onboarding, payment or claim mutations. SQL execution and database fixtures remain for the root's isolated integration proof; this worker made no database writes.

The migration briefly locks moderation tables in `SHARE` mode and target identities with row locks to prevent check/write races. A concurrent write may wait or a conflicting transaction may abort. The audit carries full copies only of public profile data and inserted links, enabling precise restoration. External destinations and image availability can change after this review; deployment must check the rendered pages and current destinations. No remote database write or publication is performed by creating these files.
