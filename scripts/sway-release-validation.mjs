// Read-only release observation is not a test run or deployment approval.
// The existing validator is preserved byte-for-byte in the adjacent module.
if (process.env.SWAY_PR249_SCOPED_SUPPLEMENT === 'true') {
  await import('./sway-pr249-scoped-supplement.mjs');
} else if (process.env.SWAY_PUBLIC_RELEASE_OBSERVATION === 'true') {
  await import('./sway-public-release-observation.mjs');
} else {
  await import('./sway-release-validation-original.mjs');
}
