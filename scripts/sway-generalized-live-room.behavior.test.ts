import assert from 'node:assert/strict';
import {
  LiveRoomMenuPolicyError,
  normalizeLiveRoomType,
  normalizeRoomRequestMenu,
  resolveRoomRequestSelection
} from '../src/server/live-room-menu-policy';
import { projectPublicRoomState } from '../src/server/public-room-state';

function expectPolicyError(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LiveRoomMenuPolicyError);
    assert.equal(error.code, code);
    return true;
  });
}

assert.equal(normalizeLiveRoomType(undefined), 'music');
assert.equal(normalizeLiveRoomType('comedy'), 'comedy');
assert.equal(normalizeLiveRoomType('service'), 'service');
assert.equal(normalizeLiveRoomType('general'), 'general');
expectPolicyError(() => normalizeLiveRoomType('venue'), 'invalid_room_type');

const serviceMenu = normalizeRoomRequestMenu([{
  id: '  Crowd Greeting  ',
  title: '  Crowd   greeting ',
  description: ' Welcome a guest by name. ',
  targetType: 'custom'
}], 'service');
assert.deepEqual(serviceMenu, [{
  id: 'crowd-greeting',
  title: 'Crowd greeting',
  description: 'Welcome a guest by name.',
  targetType: 'custom'
}]);

const musicMenu = normalizeRoomRequestMenu([{
  id: 'house-track',
  title: 'House track',
  description: 'Request a track from the synced library.',
  targetType: 'music'
}], 'music');
assert.equal(musicMenu[0].targetType, 'music');

expectPolicyError(
  () => normalizeRoomRequestMenu([{ id: 'paid', title: '$20 request', description: 'Buy priority', targetType: 'custom' }], 'general'),
  'room_menu_money_claim_not_allowed'
);
expectPolicyError(
  () => normalizeRoomRequestMenu([{ id: 'drink', title: 'Free cocktail', description: 'Ask for a drink', targetType: 'custom' }], 'service'),
  'room_menu_regulated_offer_not_allowed'
);
expectPolicyError(
  () => normalizeRoomRequestMenu([{ id: 'stunt', title: 'Fire stunt', description: 'Risky audience act', targetType: 'custom' }], 'comedy'),
  'room_menu_unsafe_offer_not_allowed'
);
expectPolicyError(
  () => normalizeRoomRequestMenu([
    { id: 'same', title: 'First', description: 'First prompt', targetType: 'custom' },
    { id: 'same', title: 'Second', description: 'Second prompt', targetType: 'custom' }
  ], 'general'),
  'duplicate_room_menu_id'
);
expectPolicyError(
  () => normalizeRoomRequestMenu(Array.from({ length: 9 }, (_, index) => ({
    id: `item-${index}`,
    title: `Item ${index}`,
    description: `Description ${index}`,
    targetType: 'custom'
  })), 'general'),
  'room_menu_too_large'
);
expectPolicyError(
  () => normalizeRoomRequestMenu([{ id: 'song', title: 'Song', description: 'Play a song', targetType: 'music' }], 'comedy'),
  'room_menu_target_mismatch'
);

const selected = resolveRoomRequestSelection({
  roomType: 'service',
  requestMenu: serviceMenu,
  menuItemId: ' CROWD-GREETING ',
  requestedTargetType: 'custom'
});
assert.equal(selected.menuItem?.title, 'Crowd greeting');
assert.equal(selected.targetType, 'custom');
expectPolicyError(() => resolveRoomRequestSelection({
  roomType: 'service',
  requestMenu: serviceMenu,
  menuItemId: 'menu-item-from-another-room',
  requestedTargetType: 'custom'
}), 'room_menu_item_not_available');
expectPolicyError(() => resolveRoomRequestSelection({
  roomType: 'comedy',
  requestMenu: [],
  menuItemId: null,
  requestedTargetType: 'music'
}), 'room_request_target_mismatch');

const linkedEvent = {
  id: '22222222-2222-4222-8222-222222222222',
  title: 'Friday service night',
  startsAt: '2030-08-23T01:00:00.000Z',
  eventPath: '/e/22222222-2222-4222-8222-222222222222',
  attendanceMode: 'walk_in' as const
};
const publicState = projectPublicRoomState({
  session: {
    status: 'active',
    talentName: 'Working Professional',
    talentRole: 'Performer',
    roomType: 'service',
    requestMenu: serviceMenu,
    linkedEventId: linkedEvent.id,
    linkedEvent,
    feeType: 'patron',
    minimumTip: 5,
    requestsOpen: true,
    requestWindowMode: 'manual',
    requestWindowExpiresAt: null,
    requestWindowDuration: null,
    requestWindowLabel: null,
    operatingMode: 'manual',
    searchScope: 'library',
    paymentsEnabled: false,
    tipsEnabled: false
  },
  requests: [],
  performers: [],
  activeGigId: '11111111-1111-4111-8111-111111111111'
} as never);
assert.equal(publicState.session.roomType, 'service');
assert.deepEqual(publicState.session.requestMenu, serviceMenu);
assert.deepEqual(publicState.session.linkedEvent, linkedEvent);
assert.equal(publicState.session.paymentsEnabled, false);
assert.equal(publicState.session.tipsEnabled, false);
assert.equal('linkedEventId' in publicState.session, false, 'Public room state must expose only the safe event projection.');

console.log('Sway generalized live-room behavior test passed.');
