// Validation-service diagnostic wrapper; not a production runtime change.
// Preserve the exact full release suite as the default. Read-only delivery
// checks have a separate mode and never count as passing the full suite.
if (process.env.SWAY_POST_RELEASE_READ_ONLY_PROOF === 'true') {
  await import('./sway-public-release-delivery-proof.mjs');
} else {
  await import('./sway-release-validation-suite.mjs');
}
