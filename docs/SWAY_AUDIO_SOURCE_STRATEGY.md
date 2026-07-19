# Sway Audio Source Strategy

Date: 2026-07-07

## Decision

Sway should become the performer's live control hub, but it must not claim that Spotify, SoundCloud, or any third-party catalog will automatically play full tracks from inside Sway unless that provider explicitly permits the exact commercial venue/performance use.

The near-term product is:

- Sway manages the room, requests, tips, boosts, queue, overlay, and audience display.
- Sway syncs or links to the performer's music library so requests can be matched to what the performer can actually play.
- The performer plays audio from their existing lawful playback stack unless Sway operates an authorized, licensed playback path for that source.

The future paid product can be:

- a Sway audio console for performer-owned uploads, locally licensed files, or provider-approved catalogs
- add-on deck/mixer/console controls
- deeper integrations with DJ software, OBS, and approved music providers

## Why Sway Cannot Promise Universal Built-In Playback

### Spotify

Spotify's developer policy blocks the version where Sway becomes a monetized club playback source for Spotify tracks:

- Spotify says products targeted for use by businesses, including bars and restaurants, are not allowed because Spotify is for personal, non-commercial use.
- Streaming Spotify content in a commercial Streaming SDA is restricted.
- Spotify prohibits products that play one source to several simultaneous listeners, combine Spotify streams with other services, synchronize recordings with visual media, or segue/mix Spotify content.

Official source:

- https://developer.spotify.com/policy

Product implication:

- Sway may use Spotify metadata/search only when configured and compliant.
- Sway must not sell or imply "Spotify plays from Sway" for club/performance rooms.
- Spotify links/deep links can help the performer find or open a track in Spotify, but venue playback/licensing remains outside Sway unless Spotify grants a specific approved path.

### SoundCloud

SoundCloud is more flexible than Spotify, but not unlimited:

- SoundCloud supports OAuth, uploads, search, widgets, and stream URLs.
- Some commercial use is allowed, but SoundCloud restricts embedding or commercializing user content in third-party commercial services unless it fits approved cases.
- Not all tracks are streamable off-platform. Tracks can be playable, preview-only, or blocked.
- Attribution and links back to SoundCloud are required when displaying or streaming SoundCloud content.

Official sources:

- https://developers.soundcloud.com/docs/api/guide
- https://developers.soundcloud.com/docs/api/terms-of-use

Product implication:

- SoundCloud login can be a real candidate for a first provider connector.
- Sway should start with authenticated account linking, track availability, and creator/uploader-approved playback paths.
- Sway must store track access state and fail closed when a SoundCloud track is blocked, preview-only, private without authorization, geo-blocked, or otherwise unavailable.

## Build Lanes

### Lane 1: Library Availability

Purpose:

- Let performers connect whatever library/workflow they already use.
- Sync track metadata and availability into Sway.
- Let patrons request from library, setlist, or catalog scope.

Already present:

- linked library sources
- sync keys
- `/api/library/sync`
- local bridge script
- library/setlist/catalog search scope

Not included:

- audio playback
- deck loading
- waveform/mixer controls

### Lane 2: Provider Account Links

Purpose:

- Let performers connect provider accounts where allowed.
- Import or search metadata.
- Store external IDs, URLs, artwork, availability, and access status.
- Expose open/deep-link actions for the performer.

First candidates:

- SoundCloud, because its API includes OAuth, track upload/playback concepts, and access states.
- Spotify metadata/search only, unless a compliant commercial playback approval exists.

Required safeguards:

- provider token storage must be encrypted or otherwise protected
- disconnect/revoke must delete provider personal data and tokens
- each provider must have an explicit capability matrix: metadata, search, import, stream, upload, launch/deep-link
- UI copy must say "open in provider" or "matched in provider" unless Sway can legally play the track

### Lane 3: Sway Audio Console

Purpose:

- Paid performance console that can actually play audio when Sway has lawful audio rights.

Allowed sources:

- performer-owned uploads
- local files routed through a local companion app
- royalty-free/licensed catalogs Sway contracts for
- provider tracks only where the provider's terms and approval permit that exact commercial playback use

Required before shipping:

- durable provider/source schema
- token lifecycle and disconnect audit records
- file/license provenance records for uploaded/local audio
- playback audit records
- failure states for missing license, expired token, blocked track, offline source, or unsupported venue use
- copy that does not imply payout, licensing, or playback rights that Sway does not control

## UX Direction

The performer cockpit should eventually show:

- Now playing
- Up next
- Pending requests
- Approved queue
- Source badge: Library, Setlist, Spotify metadata, SoundCloud, Local, Upload
- Availability badge: playable in Sway, open in source, metadata only, blocked, expired auth
- Action button based on capability: Play in Sway, Open in provider, Send to local companion, Mark playing

The audience/projector screen should not expose provider complexity. It should show:

- scan call-to-action
- now playing
- up next
- request/tip/boost state

## Non-Negotiables

- No claim that Spotify plays from Sway in venue/commercial mode.
- No generic "plays from Sway" claim for third-party catalogs.
- No streaming provider token work without durable token lifecycle, disconnect, and audit behavior.
- No paid audio console for provider playback until the provider's terms and approvals permit it.
- No uploaded/local audio console without provenance and license/audit records.
- No client-only provider authorization boundary.

## Next Safe Slice

Build a provider/source capability model before OAuth UI:

- provider id
- provider display name
- capability flags
- auth required
- token storage status
- disconnect status
- source availability states
- explicit UI labels for "playable in Sway" versus "open in provider"

Then implement one provider connector at a time, starting with SoundCloud only if the app has API credentials and a compliant use case.

## Owner-Directed Publishing Expansion (2026-07-18)

The owner has explicitly reordered the audio lane: Sway should grow from source metadata and live-room control into creator-owned audio collaboration, Sway-only publication/playback, catalog migration, and external distribution through an approved delivery partner.

This does not relax the source restrictions above. Spotify remains metadata/deep-link only for Sway's commercial live-room use unless Spotify approves a different path. Performer-owned audio becomes playable or distributable only after Sway has private lossless storage, durable access, rights evidence, moderation, playback/reporting, takedown, and delivery controls for that exact use.

Continuum plugs into this lane as a source-manifest, embed, derivative-planning, and portable-media connector. Its current hosted publisher stores validated manifests, not lossless audio masters or Sway account permissions. When that storage slice is implemented, Sway—not Continuum—must operate the master vault and serve as system of record for immutable checksum identity, project access, release state, rights evidence, and audit history; connector capabilities remain fail-closed. Creators retain their copyrights.

The first implementation contract is documented in `docs/SWAY_AUDIO_PUBLISHING_FOUNDATION.md`.
