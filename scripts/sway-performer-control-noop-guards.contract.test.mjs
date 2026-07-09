import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const talentDashboard = readFileSync(join(root, 'src/components/TalentDashboard.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const failures = [];

for (const term of [
  'writeMutationNoopAudit',
  'duplicate_noop: true',
  'noop_reason: input.reason',
  "eventType: `${input.eventType}.noop`",
  'already_in_target_state',
  'incompatible_terminal_state',
  'request_removed',
  'request_hidden'
]) {
  if (!server.includes(term)) {
    failures.push(`Duplicate/noop audit guard missing term: ${term}`);
  }
}

for (const term of [
  "eventType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`",
  "previousStatus === nextStatus",
  "action === 'approve' && previousStatus === 'denied'",
  "request.status = nextStatus"
]) {
  if (!server.includes(term)) {
    failures.push(`Triage noop/status guard missing term: ${term}`);
  }
}

const triageStart = server.indexOf('async function applyRequestTriage');
const triageMutation = server.indexOf('request.status = nextStatus', triageStart);
const triageSideEffect = server.indexOf('paymentService.isEnabled()', triageStart);
if (triageStart === -1 || triageMutation === -1 || triageSideEffect === -1 || triageMutation > triageSideEffect) {
  failures.push('Triage status assignment must happen only after noop guards and before money side effects.');
}

for (const term of [
  "eventType: 'request.fulfill'",
  "previousStatus === 'fulfilled'",
  "previousStatus !== 'approved'",
  "request.status = 'fulfilled'"
]) {
  if (!server.includes(term)) {
    failures.push(`Fulfill noop/status guard missing term: ${term}`);
  }
}

const fulfillStart = server.indexOf('async function applyRequestFulfill');
const fulfillMutation = server.indexOf("request.status = 'fulfilled'", fulfillStart);
const fulfillSideEffect = server.indexOf('paymentService.isEnabled()', fulfillStart);
if (fulfillStart === -1 || fulfillMutation === -1 || fulfillSideEffect === -1 || fulfillMutation > fulfillSideEffect) {
  failures.push('Fulfill status assignment must happen only after noop guards and before money side effects.');
}

for (const term of [
  "eventType: 'moderation.hide'",
  'if (request.hidden)',
  'if (request.removed)',
  'request.hidden = true'
]) {
  if (!server.includes(term)) {
    failures.push(`Hide noop/status guard missing term: ${term}`);
  }
}

const hideStart = server.indexOf('async function applyRequestHide');
const hideMutation = server.indexOf('request.hidden = true', hideStart);
const hideSideEffect = server.indexOf('paymentService.isEnabled()', hideStart);
if (hideStart === -1 || hideMutation === -1 || hideSideEffect === -1 || hideMutation > hideSideEffect) {
  failures.push('Hide mutation must happen only after noop guards and before money side effects.');
}

for (const term of [
  'CONTROL_BRIDGE_MUTATING_ACTIONS',
  'CONTROL_BRIDGE_REPLAY_WINDOW_MS',
  'controlBridgeReplayCache',
  'reserveControlBridgeMutation',
  "'toggle-requests'",
  "'fulfill-top'",
  "'hide-top'",
  "'approve-pending'",
  "'veto-pending'",
  "noopReason: 'control_bridge_replay_window'",
  "eventType: `control_bridge.${action}`",
  "entityType: 'control_bridge_action'"
]) {
  if (!server.includes(term)) {
    failures.push(`Control bridge replay guard missing term: ${term}`);
  }
}

const bridgeRouteStart = server.indexOf("app.post('/api/talent/control-bridge/action/:action'");
const bridgeReplayIndex = server.indexOf('const replayGuard = await reserveControlBridgeMutation', bridgeRouteStart);
const bridgeTopApprovedIndex = server.indexOf('topApprovedRoomRequest(roomState)', bridgeRouteStart);
const bridgeTopPendingIndex = server.indexOf('topPendingRoomRequest(roomState)', bridgeRouteStart);
if (
  bridgeRouteStart === -1 ||
  bridgeReplayIndex === -1 ||
  bridgeTopApprovedIndex === -1 ||
  bridgeTopPendingIndex === -1 ||
  bridgeReplayIndex > bridgeTopApprovedIndex ||
  bridgeReplayIndex > bridgeTopPendingIndex
) {
  failures.push('Control bridge replay guard must run before selecting top approved or pending requests.');
}

for (const term of [
  'queueActionPendingKey',
  'queueActionPendingRef',
  'queueActionKey',
  'isQueueActionPending',
  'isRequestQueueActionPending',
  'runQueueAction',
  'if (queueActionPendingRef.current) return',
  'queueActionPendingRef.current = key',
  'queueActionPendingRef.current = null',
  "runQueueAction(req.id, 'approve'",
  "runQueueAction(req.id, 'veto'",
  "runQueueAction(req.id, 'hide'",
  "runQueueAction(req.id, 'remove'",
  "runQueueAction(req.id, 'fulfill'",
  'data-sway-queue-action-pending',
  'disabled={isRequestQueueActionPending(req.id)}',
  'disabled={previewMode || isRequestQueueActionPending(req.id)}'
]) {
  if (!talentDashboard.includes(term)) {
    failures.push(`Talent queue UI pending lock missing term: ${term}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-performer-control-noop-guards.contract.test.mjs')) {
  failures.push('test:contracts must include the performer/control noop guard contract.');
}

if (failures.length) {
  console.error('Performer/control noop guard contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Performer/control noop guard contract passed.');
