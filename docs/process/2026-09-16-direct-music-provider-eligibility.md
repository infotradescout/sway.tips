# Direct-music provider eligibility — researched requirements, not activation evidence

## User requirement
Connect a third-party music account, browse authorized music, choose a supported playback destination, and control it from Sway. Manual file imports, a provider website link, an unplayed room file, or a preview-only widget do not satisfy the requested experience.

## Spotify: technical adapter implemented; intended-use approval not established
Spotify documents user-authorized Player API controls and device selection. Start/Resume requires Premium and warns that execution order across Player operations is not guaranteed. This adapter serializes commands and separates accepted responses from subsequently observed state.

Its published Developer Policy prohibits targeting businesses/public music playback and restricts commercial Streaming SDAs. Sway's intended venue/paid-interaction use cannot be treated as authorized by a standard client ID or consumer subscription. No exception or approved partner agreement was verified. Activation remains off; an operator approval reference must identify real authorization, not make it true by assertion.

The adapter follows the 2026 playlist `items` endpoint/envelopes and search limit of 10. It does not require the removed Development Mode `/me` product/email/country fields. PKCE state/verifier handling and refresh are server-side.

Sources: https://developer.spotify.com/policy ; https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback ; https://developer.spotify.com/documentation/web-api/reference/get-a-users-available-devices ; https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide ; https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow

## Apple Music: SDK playback is not generic desktop remote control
Apple documents user authorization, catalog/library access and MusicKit playback on supported platforms, including web playback through its SDK. Developer tokens require an operator-created media identifier/private key. This does not establish arbitrary control of a separately running Apple Music desktop application, or permission for Sway's commercial venue use. No Apple Music adapter, developer credentials, or real-account proof was added here.
Source: https://developer.apple.com/musickit/

## SoundCloud: direct authorization and provider playback options need qualification
The API guide documents OAuth 2.1 with PKCE, authorized user resources, and playback through its widget or available streams. It distinguishes fully playable, preview-only and blocked tracks. Those options are not evidence of general remote control over the SoundCloud consumer application or approval of Sway's commercial workflow. No SoundCloud adapter or live account was implemented here.
Source: https://developers.soundcloud.com/docs/api/guide

## TIDAL and Soundtrack remain separate decisions
TIDAL has developer API/SDK and Connect documentation; this work does not claim a usable TIDAL Connect controller, full-track authorization, or completed TIDAL implementation.
Sources: https://developer.tidal.com/documentation ; https://developer.tidal.com/documentation/connect

Soundtrack's official SDK page describes a technology-partner process and interoperability with API controllers, and gives sdk@soundtrack.io as a partnership contact. That is a business-oriented route to qualify, not an already approved Sway integration. Exact third-party authorization, controls, subscriptions, on-demand audience requests, paid boosts and public-performance permissions must be confirmed rather than inferred from a background-music product.
Source: https://developer.soundtrackyourbrand.com/

## Qualification work prepared
A scoped search of connected email did not locate an existing Sway/Soundtrack/Spotify developer partnership approval. A nonbinding inquiry was saved as a Gmail draft to Soundtrack's published partner contact. It explicitly asks about external API control rather than embedding audio, independent customer authorization, eligible players, exact-track requests, paid priority/tips, territories and review requirements. It was NOT sent. No NDA, subscription, commercial agreement, provider application or certification was accepted.

## Release decision
Technical correctness does not establish provider approval, real-account success or audible playback. Do not substitute simulated consent for real provider consent or label previews as full playback. Do not make Spotify the only possible launch path when its standard terms conflict with Sway's intended product. Qualify an approved route while preserving the account-to-player requirement.
