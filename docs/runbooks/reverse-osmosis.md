# Business account profile review

Sway uses the shared Infinity Reverse Osmosis package pinned in `vendor/infinity-reverse-osmosis/PROVENANCE.json`. The unchanged shared core owns business-asset policy; Sway owns performer permissions, database effects and explicit operator review.

Open the public profile editor after saving pending edits. Business account review shows only attached assets whose trusted connector evidence passes the shared policy. A personal administrator login does not authorize its personal feed or every asset it manages. Manual social URLs are public-page links and do not create a verified connection.

Review the exact business account, native profile, direction and proposed bio/headline/city. Proposal creation has no effect. Explicit approval binds the immutable fields, digest, source and native versions, business attachment and owner. Applying a verified incoming proposal changes the original owned profile and records its new revision and outcome in one database transaction. Manual profile saves advance the same native revision and invalidate stale reviews.

Only trusted server connectors can provide incoming proposals or business verification. The public preview endpoint captures saved native fields itself; clients cannot supply private fields, source events or verification claims. This bounded adapter supports bio, headline and city. It does not change profile visibility, booking contacts, payments or music-player controls.

No provider publishing transport or verified business account is configured by this change. Without one, outbound execution records a durable hold and never claims publication. A real connection requires an already authorized supported connector and exact business asset; no new account, credentials or grant is created by these routes. Provider integration is a separate prerequisite, not proved by synthetic tests.

If delivery is uncertain, use **Check saved outcome**. This read cannot resend a command or release a hold. The owner can read durable bookkeeping after a connection becomes stale or revoked, while fresh effect authorization still fails closed. Claimed or held operations block new event IDs and both directions for that native profile. A process restart does not retry them. Reconciliation requires actual delivery/absence evidence; this adapter never invents absence or blindly resends.

Tests use the actual native HTTP registrar, migration and disk-backed PGlite database with explicitly synthetic authentication and connector evidence. Browser checks use mock HTTP responses. They prove isolated application behavior, not human sign-in, provider verification, customer consent or live publication. The prior actual VLC proof remains separate, as does the required cloud player server receipt echo.
