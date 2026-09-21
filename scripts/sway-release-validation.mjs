// Explicit isolated modes never run production or repeat other evidence gates.
if (process.env.SWAY_MIXXX_NATIVE_BOOTSTRAP === 'true') {
  await import('./sway-mixxx-bootstrap.mjs');
} else if (process.env.SWAY_PR249_SCOPED_SUPPLEMENT === 'true') {
  await import('./sway-pr249-scoped-supplement.mjs');
} else if (process.env.SWAY_PUBLIC_RELEASE_OBSERVATION === 'true') {
  await import('./sway-public-release-observation.mjs');
} else {
  await import('./sway-release-validation-original.mjs');
}
