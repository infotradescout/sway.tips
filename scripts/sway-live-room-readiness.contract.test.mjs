import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];

function read(relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

function requireIncludes(source, term, message) {
  if (!source.includes(term)) failures.push(message);
}

function requireExcludes(source, term, message) {
  if (source.includes(term)) failures.push(message);
}

const talentApp = read('src/shells/TalentApp.tsx');
const talentDashboard = read('src/components/TalentDashboard.tsx');
const performerShareKit = read('src/components/PerformerShareKit.tsx');
const adminApp = read('src/shells/AdminApp.tsx');
const adminCompat = read('src/shells/admin/AdminOpsRuntimeCompat.tsx');
const patronApp = read('src/shells/PatronApp.tsx');
const patronView = read('src/components/PatronView.tsx');
const frictionClient = read('src/shells/frictionClient.ts');
const server = read('server.ts');
const businessStore = read('src/server/business-store.ts');
const packageJson = JSON.parse(read('package.json'));

requireIncludes(
  talentDashboard,
  'data-sway-room-selector="true"',
  'TalentDashboard must expose the active room selector surface.'
);
requireIncludes(
  talentDashboard,
  'Share-kit target:',
  'TalentDashboard must show which live room the share kit targets.'
);
requireIncludes(
  talentDashboard,
  'print-ready room link',
  'TalentDashboard must use truthful room-link copy instead of QR generation copy.'
);
requireIncludes(
  talentApp,
  "fetch('/api/talent/active-rooms')",
  'TalentApp must load read-only active room summaries from /api/talent/active-rooms.'
);
requireIncludes(
  talentApp,
  'selectedGigId',
  'TalentApp must track the selected room context.'
);

requireIncludes(
  performerShareKit,
  'data-share-kit-room-link="true"',
  'PerformerShareKit must expose a stable room-link surface.'
);
requireIncludes(
  performerShareKit,
  'sendShareLinkCopied',
  'PerformerShareKit must emit share-link telemetry through sendShareLinkCopied.'
);
requireIncludes(
  performerShareKit,
  'print-ready room link',
  'PerformerShareKit must describe the room link honestly.'
);

requireIncludes(
  adminApp,
  'adminActiveRoomsPath',
  'AdminApp must load the read-only active-room roster endpoint.'
);
requireIncludes(
  adminCompat,
  'data-admin-active-room-roster="true"',
  'Admin roster surface must expose active room cards.'
);
requireIncludes(
  adminCompat,
  'Active room roster',
  'Admin roster surface must use the approved active-room roster title.'
);
requireExcludes(
  adminApp + adminCompat,
  "postJson('/api/admin",
  'Admin read-only roster must not introduce admin mutation posts.'
);

requireIncludes(
  patronApp,
  'sendRoomEntryViewed',
  'PatronApp must emit room_entry_viewed telemetry.'
);
requireIncludes(
  patronApp,
  'sendPatronNoSessionRecoveryViewed',
  'PatronApp must keep no-session recovery telemetry.'
);
requireIncludes(
  patronView,
  'sendRequestStarted',
  'PatronView must emit request_started telemetry.'
);
requireIncludes(
  patronView,
  'sendBoostStarted',
  'PatronView must emit boost_started telemetry.'
);
requireIncludes(
  patronView,
  'Request songs or actions, send a direct tip, or boost an approved queue item',
  'PatronView hero copy must clarify Request, Tip, and Boost entry choices.'
);
requireExcludes(
  patronView,
  'QrCode',
  'PatronView must not render fake QR graphics in the readiness bundle.'
);

for (const term of [
  'room_entry_viewed',
  'room_entry_recovery_viewed',
  'share_link_copied',
  'request_started',
  'boost_started'
]) {
  requireIncludes(frictionClient, `'${term}'`, `frictionClient must allow telemetry event: ${term}`);
  requireIncludes(server, `'${term}'`, `server telemetry allowlist must include: ${term}`);
}

requireIncludes(
  businessStore,
  'listActiveRoomSummaries',
  'business-store must provide active room summary listing for concurrent rooms.'
);
requireIncludes(
  server,
  'app.get("/api/talent/active-rooms"',
  'server must expose /api/talent/active-rooms.'
);
requireIncludes(
  server,
  'app.get("/api/admin/active-rooms"',
  'server must expose /api/admin/active-rooms.'
);

requireIncludes(
  packageJson.scripts?.['test:contracts'] ?? '',
  'node scripts/sway-live-room-readiness.contract.test.mjs',
  'test:contracts must include the live-room readiness contract.'
);

if (failures.length) {
  console.error('Sway live room readiness contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway live room readiness contract passed.');
