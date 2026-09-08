# Public profile layout

Public profiles use the person's saved performer roles and public content. Owners can arrange their sections on the public page, preview their changes, then save them for every visitor and device. They can restore the suggested layout without changing any profile content.

## Suggested layouts

The first saved role controls the suggested order. Multiple roles continue to be shown on the profile; choosing a custom order takes precedence over every suggested order.

| Saved type | Content emphasis |
| --- | --- |
| Musician or producer | Releases and music links, then performances and shows |
| DJ | Live room, sets and performances, then shows and booking |
| Comedian, host/MC, speaker, dancer or magician | Performances, shows and booking |
| Creator | Featured work, links and biography |
| Other or no type | Identity, biography and available public sections |

Only sections with public content appear to visitors. The owner sees all nine tiles in Arrange profile: profile header, about, live room, shows/events, releases, featured performances, links, booking, and social links. Empty sections keep their saved position for when content becomes available. Every section, including the header, can be moved.

The profile header prioritizes an available live room, otherwise a saved destination appropriate to the person's role. It never invents a playable release, show, follower count, booking contact or payment action. Saved external booking links remain separate from verified direct booking contact. Repeated booking and social destinations are consolidated.

## Editing and recovery

Only the authenticated owner of the exact profile handle sees Arrange profile. Pointer dragging works with mouse and touch. Named earlier/later buttons provide keyboard and alternative touch controls; pointer-only grips do not add inert keyboard stops. The compact board shows three columns on ordinary phone widths and two on narrower screens. Preview layout hides the board while keeping Save and Cancel available above the actual page. Arrange sections returns to the same draft. The real profile preview updates immediately; visitors see the last saved arrangement until Save layout succeeds. Cancel discards the local draft. The browser warns before leaving with unsaved changes.

Failed or unconfirmed saves retain the draft. A revision conflict offers two explicit choices: reload the current saved arrangement, or keep the local arrangement against the latest revision and press Save again. No conflict silently overwrites another device's changes. Expired/revoked owner access ends editing and returns to the last public layout.

## Public presentation

The profile reuses the existing neon S artwork and app icon, the shared typography, and fuchsia action colors. The saved portrait and handle lead a continuous page; section headings and dividers replace the previous equal-weight card grid. The backdrop is subdued to preserve text readability. Shows use the shared event card's compact option so missing artwork does not create a large empty panel; event dates, locations and destinations remain available. Type defaults and owner order still determine the reading sequence.

## Persistence and access contract

Existing `performer_public_profiles.metadata.publicProfileLayout` stores the optional custom `sectionOrder` and monotonic `revision`; no new schema migration is required. A null order represents the type-based default. Unknown or duplicate section keys are rejected, partial valid orders append remaining sections deterministically, and unknown existing metadata is preserved.

- GET `/api/talent/profile/layout?handle=...` returns the owned handle and safe resolved layout.
- POST `/api/talent/profile/layout` accepts only `handle`, `sectionOrder` (valid array or null reset), and `expectedRevision`.
- The server checks authenticated actor ownership and the exact normalized handle. A different user's profile is inaccessible even if the caller has performer/admin claims.
- The transaction locks performer then profile, checks the revision, writes metadata, and records the audit together. The existing full-profile save takes the same locks before reading metadata so content and layout saves preserve each other.
- Stale requests return 409 with safe current layout. Invalid requests return 422. Anonymous/unauthorized requests cannot mutate a profile.
- Public `/api/public/performer/:handle` exposes only the resolved layout, never private metadata or owner identifiers. Layout writes do not publish a draft profile, claim an account, grant membership, verify booking contact, or activate money.

## Evidence and release

`npm run test:profile-layout` runs pure layout behavior, disposable PostgreSQL HTTP persistence/authorization/audit proof, and actual-browser layout interactions with explicitly synthetic API fixtures. Its browser proof is separate from backend persistence evidence. `test:contracts` includes the layout behavior gate. Standalone PostgreSQL additionally proves controlled layout/layout and layout/content contention through distinct blocked backends.

The friend-publication integration renders the four existing artist profiles and assets against the real application and disposable database. Lint, build and full contract gates remain required. Merge and automatic production deployment require their own explicit authorization under RELEASE_CONTROL.md; this document creates none.
