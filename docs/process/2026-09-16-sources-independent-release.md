# Independent Sources integration

Objective: Let performers set up requestable libraries and reach existing external-player controls without waiting for unrelated collaborator revisions or payout migrations. Audio remains in the original player. Imports are not full provider integrations.

Base branch/commit: main, e2c6a49b301f26237b83e8a403b4dae72bdbd621.
Current branch: implement/sway-sources-release-20260916.

Composition: Start with the pre-account/payout Sources tree at 167b0e77997d1a5f95f852fc26cfad2b85dc956f, preserve current-main AGENTS.md, copy the isolated source-count endpoint repair from PR 242, current named-import identity helper and safe browser failure handling, and the player setup/controller composition from PR 245. No collaborator, payout, account-access, schema, package or production configuration changes are included. The original source-only dashboard retains its account-owned saved-music totals. New outer account/performer/preview keyed composition prevents obsolete dashboard library reads from populating a different account; same-account profile edits and room selection do not remount it.

Verified completed work: Previous stacked candidate b88ba3ac passed its isolated gates. This extraction has a different tree and needs its own acceptance. Do not reuse the old full pass as current proof.
Changed but unverified work: The independent integration and account-key boundary, including compatibility with main's existing browser tests.
Files changed: Source chooser/parsers/import helper; source-count endpoint; player setup/context and TalentApp composition; scoped Sources and role contracts and import/player browser tests; VirtualDJ deadline adapter; this checkpoint. Confirm the exact diff against base before publication.
Tests/evidence already run: Previous donor evidence only. Current candidate not yet run.
Tests/evidence invalidated: Whole-tree acceptance from PR 245 does not attest this extraction.
Known risks: This is not a new Spotify, Apple Music, TIDAL or SoundCloud authorization flow. Spotify recovery changes still in PR 243 are not silently included because they touch mixed server/dashboard owners. Physical player and full provider evidence remain separate.
External side effects and retry safety: Draft GitHub branch only at this checkpoint. No production, customer records, providers, schema or financial terms changed.
Next exact action: Verify source-only diff, validate this exact candidate with the existing source-workspace proof runner and record its result. Fix only concrete integration failures. Continue actual source integrations after the independent delivery candidate is accepted.
Actions not to repeat: Do not merge the collaborator stack, do not rerun a feature audit, do not treat metadata imports or mock acknowledgements as completed source connections, and do not activate money. Production merge/deploy remains a separate explicitly authorized action under RELEASE_CONTROL.md.
