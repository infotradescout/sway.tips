// Explicit isolated modes never change production or repeat other evidence gates.
if (process.env.SWAY_ACQUISITION_QUALITY_PROOF === 'true') {
  await import('./sway-acquisition-quality-proof.mjs');
} else if (process.env.SWAY_DISCOVERY_ENTRY_PROOF === 'true') {
  await import('./sway-discovery-entry-proof.mjs');
} else if (process.env.SWAY_ATTRIBUTION_DEPLOYED_SHA) {
  await import('./sway-discovery-attribution-production.mjs');
} else if (process.env.SWAY_DISCOVERY_ATTRIBUTION_CONTRACT_RESUME === 'true') {
  await import('./sway-discovery-attribution-contract-resume.mjs');
} else if (process.env.SWAY_DISCOVERY_ATTRIBUTION_PROOF === 'true') {
  await import('./sway-discovery-attribution-proof.mjs');
} else if (process.env.SWAY_PUBLIC_INFO_SCOPED_SUPPLEMENT === 'true') {
  await import('./sway-public-information-scoped-proof.mjs');
} else if (process.env.SWAY_PUBLIC_INFO_DISCOVERY_PROOF === 'true') {
  await import('./sway-public-information-discovery-proof.mjs');
} else if (process.env.SWAY_MIXXX_NATIVE_BOOTSTRAP === 'true') {
  await import('./sway-mixxx-bootstrap.mjs');
} else if (process.env.SWAY_PR249_SCOPED_SUPPLEMENT === 'true') {
  await import('./sway-pr249-scoped-supplement.mjs');
} else if (process.env.SWAY_PUBLIC_RELEASE_OBSERVATION === 'true') {
  await import('./sway-public-release-observation.mjs');
} else {
  await import('./sway-release-validation-original.mjs');
}
