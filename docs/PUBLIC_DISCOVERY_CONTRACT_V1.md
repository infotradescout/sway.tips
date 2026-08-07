# Public Discovery Contract v1

**Status:** Versioned governance lock for ecosystem public discovery.  
**Reference fixture:** JW Stone (business + public inventory discovery behavior — not a visual template).  
**Authority:** Thomas. Feature branches only until separately authorized. **Do not merge. Do not deploy.** Do not change production indexing until intended public surfaces are proven.

## Purpose

Standardize the working public-discovery pattern proven by the JW Stone ChatGPT referral → return visit → call acquisition event:

1. Public crawler access  
2. Useful facts in the first server response  
3. Stable addresses for categories and individual inventory/entities  
4. Consistent public identity  
5. Real supporting evidence  
6. One clear human primary action  
7. Source attribution through the journey  

Do **not** clone JW Stone’s visual design. Reuse discovery behavior only.

## Non-goals

- Fake city, county, service, inventory, event, product, performer, or listing pages  
- Guessed or placeholder public facts  
- Pay-to-play ranking or lead selling  
- Exposing private records to improve discovery  
- Mixing brand data models (MealScout ≠ TradeScout; Sway Live Rooms ≠ Self-Production)  
- Weakening Skill Gaming World private-preview protections  
- Treating “indexed page count” as the success metric  

## 1. One clear public identity

Every public entity must have:

| Requirement | Rule |
| --- | --- |
| Official name | One official name |
| Canonical address | One permanent canonical URL |
| Category | One clear category |
| Description | Useful plain-English description |
| Service / operating areas | Verified when public |
| Public image | Current, real |
| Outside identities | Verified where applicable |
| Freshness | Visible last-verified or last-updated date |

Custom domains and platform profiles must agree on which address is canonical.

## 2. Useful facts in the first response

A crawler must receive useful facts **before** depending on JavaScript.

The first HTTP response body must contain:

- Unique page title  
- Real heading  
- Concise summary  
- Entity name and type  
- Location or service area when public  
- Relevant categories  
- Relevant products, services, menu items, events, releases, or listings  
- Permanent links to related pages  
- The correct primary action  

An empty application shell is a **failed** discovery page even if it looks correct after a full browser load.

## 3. One permanent address per real intent

Filtering with temporary screen state cannot replace permanent public addresses.

Examples of one address per intent: one business, service, inventory item, material category, menu, dish, performer, event, release, property listing, labor-rate benchmark, product, or owner-approved asset listing.

## 4. Verified structured facts

Each eligible page must describe the correct entity kind (LocalBusiness, Product, Offer, Event, Person/MusicGroup, MusicAlbum/MusicRecording, Restaurant, Menu, RealEstateListing, Service, Vehicle/Vessel/RV/Equipment where owner-approved).

Structured facts and visible facts must agree. No guessed schema.

## 5. Controlled crawler policy

Each system must publish:

- Public routes crawlers may inspect  
- Private routes crawlers must not inspect  
- A valid sitemap containing **only** eligible public pages  
- Clear canonical-domain policy  
- Separate search-discovery vs training-crawler decisions  
- Correct content types for crawler instructions and sitemaps  

A sitemap or robots address returning an application shell is a **hard failure**.

## 6. Real conversion path

Every public page needs **one** primary human action.

| System | Primary action |
| --- | --- |
| TradeScout / connected businesses | Start a Request |
| MealScout | View menu, schedule, ordering option, or public profile action |
| Sway | View performer, attend event, enter a Live Room, or follow an approved release action |
| HomeScout | Inspect owner-approved listing and start direct contact |
| ScoutFitters | Inspect product and purchase or request |
| Public asset listings | Inspect asset and begin owner-approved connection |

Do not offer five competing primary buttons. Preserve “Connection Without Compromise.” Do not expose a trade professional’s personal phone when Direct Connect is the approved path.

## 7. Complete source attribution

Preserve the original discovery source through the full journey.

Record at minimum:

- First discovery source and landing address  
- First public entity type and identifier  
- First visit time and latest attributed return time  
- Material / service / product / menu / performer / event / release / property / asset viewed  
- Primary action selected  
- Public phone click where permitted  
- Start a Request initiation and submission  
- Connection acceptance  
- Completed outcome / revenue when appropriate  

Survive: navigation, return visits, account creation, Direct Connect, cross-device continuation when authenticated, later outcome reporting.

Optional offline field: **How did you find us?** (ChatGPT, Google, Facebook, referral, existing customer, other). Do **not** overwrite stronger recorded attribution with the optional answer.

Canonical event names (or equivalents):

`discovery_landing` · `discovery_entity_view` · `discovery_primary_action` · `discovery_phone_click` · `discovery_request_started` · `discovery_request_sent` · `discovery_connection_accepted` · `discovery_outcome_recorded`

## 8. Live production proof

Every public deployment must prove:

- Real public domain returns correct content  
- Crawler receives a successful response with correct content type  
- Visible facts present in first response  
- Canonical address correct  
- Page present in sitemap  
- Not accidentally blocked; protected routes remain blocked  
- Source tag survives the visit; action recorded  
- No private information appears  

## Public eligibility rules

Eligible only when:

- Owner-claimed or system-verified public intent  
- Sufficient unique real information (not thin import)  
- Non-suspended / publicly published status  
- Canonical domain agreement  
- Structured and visible facts agree  

## Private-data exclusions

Never publish by default:

- HomeID Vault / private documents / private addresses  
- AutoID / MarineID / RVID / EquipID identifiers, serials, storage locations, private ownership records  
- Skill Gaming World accounts, wallets, eligibility, gameplay ops, admin  
- AutoBott / NewsFilter internal operating surfaces  
- TradeScout personal phones when Direct Connect is required  
- Unclaimed thin imports (MealScout and similar)  

## Sitemap rules

- Only eligible, successful, canonical public URLs  
- No private, missing, redirected-to-shell, duplicate, thin, placeholder, or unsuccessful pages  
- Correct `application/xml` (or sitemap index) content type  
- Canonical host consistent with robots and HTML canonical tags  

## Freshness

Every eligible page shows last-updated or last-verified. Stale public facts weaken eligibility.

## Measurement standard (success funnel)

```text
Eligible public page
→ verified crawler visit
→ ChatGPT-tagged human visit
→ meaningful entity or inventory view
→ primary action
→ accepted connection
→ completed outcome
→ measurable business value
```

Dashboards must separate crawler requests, user-triggered ChatGPT retrieval, human ChatGPT visits, return visits, primary actions, Start a Request, phone clicks, submitted/accepted connections, and completed outcomes — by brand, domain, entity type, and public address.

JW Stone is the control example.

## Rollback requirements

If a public surface ships incorrect indexing, private leakage, shell sitemaps, or fake entities: fail closed, restore prior crawler policy / remove bad sitemap entries, and record the rollback in the release evidence checklist. Do not “fix” discovery by exposing private data.

## Product lane notes

- **Sway:** Judge Live Rooms independently from Self-Production. Do not publish fake performers, demo events, demo releases, or roadmap-as-live language. Do not describe Sway.DIO catalog content as live before it exists.  
- **Skill Gaming World:** Keep existing noindex protections. Future public education only on a separate surface.  
- **HomeID:** Education + owner-approved share views only.  

## Change control

Amendments require a new contract version (`v1.1`, `v2`, …) and owner authorization. Feature work implementing this contract stays on feature branches until merge/deploy are separately authorized.
