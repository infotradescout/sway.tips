// Explicit isolated modes preserve each task's execution and evidence boundary.
if (process.env.SWAY_VLC_MPV_NATIVE_PROOF === 'true') {
  await import('./sway-vlc-mpv-native-proof.mjs');
} else if (process.env.SWAY_RETAINED_TAINT_PROOF === 'true') {
  await import('./sway-retained-taint-proof.mjs');
} else if (process.env.SWAY_QUALITY_DASHBOARD_OBSERVE) {
  await import('./sway-quality-dashboard-live.mjs');
} else if (process.env.SWAY_QUALITY_FINAL_SOURCE_ONLY === 'true') {
  await import('./sway-quality-final-source.mjs');
} else if (process.env.SWAY_QUALITY_REGRESSION_ISOLATION === 'true') {
  await import('./sway-quality-regression-isolation.mjs');
} else if (process.env.SWAY_QUALITY_DASHBOARD_SHA) {
  await import('./sway-quality-dashboard-proof.mjs');
} else if (process.env.SWAY_ACQUISITION_QUALITY_OBSERVE) {
  await import('./sway-acquisition-quality-production.mjs');
} else if (process.env.SWAY_ACQUISITION_INGRESS_INSPECT === 'true') {
  await import('./inspect-acquisition-ingress.mjs');
} else if (process.env.SWAY_ACQUISITION_QUALITY_PROOF === 'true') {
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
