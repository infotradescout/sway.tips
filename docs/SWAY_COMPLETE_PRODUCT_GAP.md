# Sway Complete Product Gap Ledger

Date: 2026-07-21  
Branch: `ops/complete-product-reentry`  
Owner bar: **Do not ship until the product is complete. Partial AI scaffolding is not a product.**

## Product Law (owner-corrected)

1. One account can be audience and creator. Stripe verification unlocks getting paid, not using the site.
2. A live room is night mode, not an entry tax. The site must be usable with zero live room.
3. Live-room money loop is one product surface, not the whole company.
4. Publishing, collaboration, file sharing, and catalog transfer are first-class product — not “after adoption.”
5. Schema/docs/contracts without durable runtime + UI + production evidence are unfinished work, not shipped features.

## Shipped on `main` (usable today)

| Surface | Status |
|--------|--------|
| Performer signup / login / session | Live |
| Live room create / queue / tip / request / boost | Live (local proven; Stripe test keys now on Render) |
| Room QR / share / overlay route | Live |
| Public profile `/p/:handle` | Live |
| Library metadata sync bridge | Live (metadata only) |
| Control bridge baseline | Merged; live hardware not proven |
| Moderation, idempotency, payments lifecycle code | Live in code |
| Pro Mode columns on `users` | Deployed; no user-facing meaning |
| Admin | Internal quarantine |

## Missing / incomplete (blocks “complete”)

### Account & home
| Gap | Truth |
|-----|--------|
| Unified account (audience + creator) | Not built. Patron signup/login held in old spine. |
| Usable home with no live room | Missing. Talent idle ≈ setup void; patron home ≈ scan-only. |
| Stripe verifies payouts / paid intake, not site access | Partially true in code; product copy/UX still room-first. |

### Publishing & catalog (DistroKid-class)
| Gap | Truth |
|-----|--------|
| Audio publishing foundation | Exists only on `origin/agent/audio-publishing-foundation` (`9a4a45b`). **Not on `main`.** |
| Migration | Branch used `0019_audio_publishing_foundation`; `main` already used `0019`–`0022` for other work. Must renumber to `0023+`. |
| Runtime uploads / private storage | Explicitly off in foundation doc |
| DistroKid / store delivery / cutover | Contract + state machine only; `CATALOG_CUTOVER_EXECUTION_ENABLED = false` |
| Sales / royalties / composition publishing admin | Not claimed; not built |

### Collaboration & file sharing
| Gap | Truth |
|-----|--------|
| Project invites / collaborator roles | Schema on branch only |
| Private file pairing QR (`/talent/connect/files`) | Spec only; no live routes |
| Exact-original download / review comments | Spec only |
| Continuum connector | Contract tests on branch; not live |

### Creator performance toolchain
| Gap | Truth |
|-----|--------|
| In-app playback / DJ software companion | Explicitly not built (`SWAY_PERFORMER_INTEGRATION_TRUTH_MAP`) |
| OBS automation beyond manual overlay URL | Not built |
| SoundCloud / Spotify as venue playback | Not allowed / not built as claimed product |

## Re-entry order (this branch)

1. Correct product spine / restart truth so work is no longer illegally “held.”
2. Port audio publishing foundation onto `main` as `0023` (schema + contracts + docs) without claiming runtime.
3. Account home that works with zero live room (Join + Start + Profile + Files entry points).
4. First durable publishing runtime slice (storage + upload seal + one share path) — only after (2)–(3) land.
5. Catalog transfer / DistroKid path remains fail-closed until continuity evidence exists.

## Explicit non-claims

- Porting the foundation does not equal shipping publishing.
- Stripe test keys on Render do not equal complete product.
- Contract tests do not equal user-visible features.
