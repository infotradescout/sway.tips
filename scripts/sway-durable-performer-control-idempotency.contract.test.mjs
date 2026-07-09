import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const store = readFileSync(join(root, 'src/server/idempotency-store.ts'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const failures = [];

for (const term of [
  'DurableActorActionInput',
  'reserveDurableActorAction',
  'completeDurableActorAction',
  'actorId: input.actorId',
  'patronDeviceIdHash: input.actorScope',
  'db.insert(idempotencyKeys)',
  '.onConflictDoNothing().returning',
  'firstResponseBodyHash'
]) {
  if (!store.includes(term)) {
    failures.push(`Durable actor idempotency store missing term: ${term}`);
  }
}

for (const term of [
  'buildDurableActorActionInput',
  'reserveDurableActorMutation',
  'completeDurableActorMutation',
  'sendDurableMutationReplay',
  "actionType: `request.triage.${action === 'approve' ? 'approve' : 'deny'}`",
  "actionType: 'request.fulfill'",
  "actionType: 'moderation.hide'",
  "actionType: `control_bridge.${input.action}`",
  'replayBucket',
  'CONTROL_BRIDGE_REPLAY_WINDOW_MS',
  "targetEntityType: 'control_bridge_action'"
]) {
  if (!server.includes(term)) {
    failures.push(`Server durable performer/control idempotency missing term: ${term}`);
  }
}

function assertOrder(label, source, first, second, from = 0) {
  const firstIndex = source.indexOf(first, from);
  const secondIndex = source.indexOf(second, from);
  if (firstIndex === -1 || secondIndex === -1 || firstIndex > secondIndex) {
    failures.push(`${label}: expected "${first}" before "${second}".`);
  }
}

function assertOrderInBlock(label, source, blockStartTerm, first, second, from = 0) {
  const blockStart = source.indexOf(blockStartTerm, from);
  if (blockStart === -1) {
    failures.push(`${label}: missing block "${blockStartTerm}".`);
    return;
  }
  assertOrder(label, source, first, second, blockStart);
}

const triageRouteStart = server.indexOf('app.post("/api/request/triage"');
assertOrder('triage route', server, 'reserveDurableActorMutation(durableMutation)', 'await applyRequestTriage', triageRouteStart);
assertOrder('triage route', server, 'await applyRequestTriage', 'completeDurableActorMutation', triageRouteStart);

const fulfillRouteStart = server.indexOf('app.post("/api/request/fulfill"');
assertOrder('fulfill route', server, 'reserveDurableActorMutation(durableMutation)', 'await applyRequestFulfill', fulfillRouteStart);
assertOrder('fulfill route', server, 'await applyRequestFulfill', 'completeDurableActorMutation', fulfillRouteStart);

const hideRouteStart = server.indexOf('app.post("/api/moderation/hide"');
assertOrder('hide route', server, 'reserveDurableActorMutation(durableMutation)', 'await applyRequestHide', hideRouteStart);
assertOrder('hide route', server, 'await applyRequestHide', 'completeDurableActorMutation', hideRouteStart);

const bridgeRouteStart = server.indexOf("app.post('/api/talent/control-bridge/action/:action'");
assertOrder('control bridge route', server, 'await reserveControlBridgeMutation', 'topApprovedRoomRequest(roomState)', bridgeRouteStart);
assertOrder('control bridge route', server, 'await reserveControlBridgeMutation', 'topPendingRoomRequest(roomState)', bridgeRouteStart);
assertOrderInBlock('control bridge toggle branch', server, "if (action === 'toggle-requests')", 'await applyWindowToggle', 'completeDurableActorMutation', bridgeRouteStart);
assertOrderInBlock('control bridge approved-top branch', server, "if (action === 'fulfill-top' || action === 'hide-top')", 'await applyRequestFulfill', 'completeDurableActorMutation', bridgeRouteStart);
assertOrderInBlock('control bridge pending-top branch', server, "if (action === 'approve-pending' || action === 'veto-pending')", 'await applyRequestTriage', 'completeDurableActorMutation', bridgeRouteStart);

for (const forbidden of [
  'stripe',
  'PaymentIntent',
  'webhook'
]) {
  const helperStart = server.indexOf('function buildDurableActorActionInput');
  const helperEnd = server.indexOf('type RoomMutationContext', helperStart);
  const helperBody = helperStart >= 0 && helperEnd > helperStart ? server.slice(helperStart, helperEnd) : '';
  if (new RegExp(forbidden, 'i').test(helperBody) || new RegExp(forbidden, 'i').test(store)) {
    failures.push(`Durable performer/control idempotency must stay provider-free: ${forbidden}`);
  }
}

const testContracts = packageJson.scripts?.['test:contracts'] ?? '';
if (!testContracts.includes('node scripts/sway-durable-performer-control-idempotency.contract.test.mjs')) {
  failures.push('test:contracts must include the durable performer/control idempotency contract.');
}

if (failures.length) {
  console.error('Durable performer/control idempotency contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Durable performer/control idempotency contract passed.');
