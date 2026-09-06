import assert from 'node:assert/strict';
import type { Page } from 'playwright';

type RoomView = {
  activeGigId?: string | null;
  room_lookup?: string;
  room_read_only?: boolean;
  session?: {
    status?: string;
    talentName?: string;
    paymentsEnabled?: boolean;
    totals?: unknown;
  };
  requests?: Array<{ id: string; title: string; status: string }>;
};

/** Continue the existing synthetic local-server journey using only UI writes.
 * This is free-room proof, never a substitute for payment-provider verification.
 */
export async function verifyFreeRoomLifecycle({
  performerPage, customerPage, baseUrl, gigId, publicPerformerName, requestTitle, restartServer
}: {
  performerPage: Page;
  customerPage: Page;
  baseUrl: string;
  gigId: string;
  publicPerformerName: string;
  requestTitle: string;
  restartServer: () => Promise<void>;
}): Promise<void> {
  const origin = new URL(baseUrl);
  assert.equal(origin.hostname, '127.0.0.1', 'Lifecycle proof is loopback-only.');
  assert.equal(origin.protocol, 'http:');
  assert.equal(new URL(performerPage.url()).origin, origin.origin);
  assert.equal(new URL(customerPage.url()).origin, origin.origin);
  assert.match(gigId, /^[0-9a-f-]{36}$/i);
  const roomUrl = (id: string) => `${origin.origin}/api/state/${encodeURIComponent(id)}`;
  const readRoom = async (id: string, page = performerPage): Promise<RoomView> => {
    const response = await page.context().request.get(roomUrl(id), { timeout: 10_000 });
    assert.equal(response.status(), 200, 'A confirmed room must remain readable in its own account scope.');
    return response.json();
  };
  const assertClosedHistoryPrivate = async () => {
    const response = await customerPage.context().request.get(roomUrl(gigId), { timeout: 10_000 });
    assert.equal(response.status(), 410, 'A customer cannot read the performer private closed recap.');
    const body = await response.json();
    assert.equal(body.room_lookup, 'ended');
    for (const field of ['session', 'requests', 'performers', 'activeGigId', 'room_read_only']) {
      assert.equal(field in body, false, `Closed public responses must not expose ${field}.`);
    }
  };
  const waitForRoom = async (id: string, description: string, accepts: (room: RoomView) => boolean) => {
    const deadline = Date.now() + 15_000;
    let room: RoomView = {};
    do {
      room = await readRoom(id);
      if (accepts(room)) return room;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(`The saved room did not confirm ${description}; status=${room.session?.status}.`);
  };
  let phase = 'receive';
  try {
    const initial = await readRoom(gigId);
    const pending = initial.requests?.find(request => request.title === requestTitle);
    assert.ok(pending, 'The performer must receive the exact customer request before moderation.');
    assert.equal(pending.status, 'hold');
    assert.equal(initial.session?.paymentsEnabled, false, 'This journey must remain a free room.');

    phase = 'approve';
    await performerPage.getByRole('button', { name: `Approve ${requestTitle}`, exact: true }).click();
    const playedButton = performerPage.getByRole('button', { name: `Mark ${requestTitle} played`, exact: true });
    await playedButton.waitFor({ state: 'visible', timeout: 15_000 });
    const approved = await waitForRoom(gigId, 'approval', room => room.requests?.some(request => request.id === pending.id && request.status === 'approved') === true);
    assert.equal(approved.activeGigId, gigId);
    const audienceApproved = await readRoom(gigId, customerPage);
    assert.equal(audienceApproved.requests?.some(request => request.id === pending.id && request.status === 'approved'), true, 'Only the approved request should enter the public queue.');

    phase = 'fulfill';
    await playedButton.click();
    await waitForRoom(gigId, 'fulfillment', room => room.requests?.some(request => request.id === pending.id && request.status === 'fulfilled') === true);
    await playedButton.waitFor({ state: 'detached', timeout: 15_000 });
    phase = 'end-room';
    const footer = performerPage.locator('.sway-live-footer');
    const [endResponse] = await Promise.all([
      performerPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/session/end', { timeout: 15_000 }),
      footer.getByRole('button', { name: 'End Room', exact: true }).click()
    ]);
    assert.equal(endResponse.status(), 200, 'End Room must complete its authorized server write.');
    const endBody = await endResponse.json();
    console.log('FREE_ROOM_END_RESPONSE', JSON.stringify({ status: endResponse.status(), roomStatus: endBody.state?.session?.status, selectedRoomMatches: endBody.state?.activeGigId === gigId }));
    assert.equal(endBody.state?.session?.status, 'ending');
    assert.equal(endBody.state?.activeGigId, gigId, 'Ending must preserve the exact selected room identity.');
    await waitForRoom(gigId, 'ending', room => room.session?.status === 'ending');
    phase = 'ending-interface';
    const recapButton = footer.getByRole('button', { name: 'Room Recap', exact: true });
    await recapButton.waitFor({ state: 'visible', timeout: 15_000 });
    await recapButton.click();
    phase = 'closed-recap';
    await performerPage.getByRole('heading', { name: 'Night recap', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    const closed = await waitForRoom(gigId, 'closeout', room => room.session?.status === 'closed');
    assert.equal(closed.session?.talentName, publicPerformerName);
    assert.equal(closed.activeGigId, gigId);
    assert.equal(closed.room_lookup, 'ended');
    assert.equal(closed.room_read_only, true);
    assert.equal(closed.requests?.some(request => request.id === pending.id && request.status === 'fulfilled'), true, 'Closing a room must retain its fulfilled request history.');
    phase = 'closed-public-boundary';
    await assertClosedHistoryPrivate();

    phase = 'restart-server-with-only-closed-room';
    await restartServer();
    const restoredClosed = await readRoom(gigId);
    assert.equal(restoredClosed.activeGigId, gigId);
    assert.equal(restoredClosed.session?.status, 'closed');
    assert.equal(restoredClosed.session?.talentName, publicPerformerName);
    assert.equal(restoredClosed.room_read_only, true);
    assert.equal(restoredClosed.room_lookup, 'ended');
    assert.deepEqual(restoredClosed.session?.totals, closed.session?.totals, 'A new server process must preserve completed room totals.');
    assert.deepEqual(restoredClosed.requests, closed.requests, 'A new server process must restore the saved request history without reseeding.');
    await assertClosedHistoryPrivate();
    const emptyRegistryResponse = await performerPage.context().request.get(`${origin.origin}/api/talent/active-rooms`);
    assert.equal(emptyRegistryResponse.status(), 200, 'The existing owner session must survive server restart.');
    const emptyRegistry = await emptyRegistryResponse.json();
    assert.deepEqual(emptyRegistry.rooms, [], 'Startup must not resurrect the only closed room as active.');

    phase = 'reload-recap';
    await performerPage.reload({ waitUntil: 'domcontentloaded' });
    await performerPage.getByRole('heading', { name: 'Night recap', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    phase = 'review-next-room';
    await performerPage.getByRole('button', { name: 'Start New Room', exact: true }).click();
    const setup = performerPage.locator('[data-sway-performer-room-setup="true"]');
    await setup.waitFor({ state: 'visible', timeout: 15_000 });
    // Choice cards include their explanatory text in the accessible name.
    // Match the anchored choice title, not an invented title-only button name.
    await setup.getByRole('button', { name: /^Free requests\b/ }).click();
    await setup.getByRole('button', { name: 'Next', exact: true }).click();
    await setup.getByRole('button', { name: /^Open requests\b/ }).click();
    await setup.getByRole('button', { name: 'Next', exact: true }).click();
    await setup.getByText(publicPerformerName, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await performerPage.getByRole('button', { name: 'Back to night recap', exact: true }).click();
    await performerPage.getByRole('heading', { name: 'Night recap', exact: true }).waitFor({ state: 'visible' });
    const unchanged = await readRoom(gigId);
    assert.deepEqual(unchanged.session?.totals, closed.session?.totals, 'Returning from setup must not overwrite the completed room totals.');
    assert.equal(unchanged.session?.status, 'closed');
    await performerPage.getByRole('button', { name: 'Start New Room', exact: true }).click();
    await setup.getByText(publicPerformerName, { exact: true }).waitFor({ state: 'visible' });
    await setup.getByRole('button', { name: 'Next', exact: true }).click();
    await setup.getByRole('heading', { name: 'Ready to go live', exact: true }).waitFor({ state: 'visible' });
    phase = 'create-next-room';
    await setup.getByRole('button', { name: 'Create room', exact: true }).click();
    await performerPage.getByRole('button', { name: 'Share Room', exact: true }).click();
    const share = performerPage.locator('[data-sway-performer-room-share="true"]').filter({ visible: true });
    const href = await share.getByRole('link', { name: 'Open Room', exact: true }).getAttribute('href');
    assert.ok(href);
    const nextUrl = new URL(href, origin.origin);
    assert.equal(nextUrl.origin, origin.origin);
    assert.match(nextUrl.pathname, /^\/g\/[0-9a-f-]{36}$/i);
    const nextId = nextUrl.pathname.slice('/g/'.length);
    assert.notEqual(nextId, gigId, 'A new room must not overwrite the completed room.');
    const nextRoom = await waitForRoom(nextId, 'next active room', room => room.session?.status === 'active');
    assert.equal(nextRoom.session?.talentName, publicPerformerName);
    assert.equal(nextRoom.session?.paymentsEnabled, false);
    assert.equal(nextRoom.requests?.length, 0, 'Previous requests must not leak into a new room.');
    const oldRoom = await readRoom(gigId);
    assert.equal(oldRoom.session?.status, 'closed');
    assert.deepEqual(oldRoom.session?.totals, closed.session?.totals);
    assert.equal(oldRoom.requests?.some(request => request.id === pending.id && request.status === 'fulfilled'), true);
    await assertClosedHistoryPrivate();
    const registryResponse = await performerPage.context().request.get(`${origin.origin}/api/talent/active-rooms`);
    assert.equal(registryResponse.status(), 200);
    const registry = await registryResponse.json();
    assert.equal(registry.rooms?.filter((room: { gigId: string }) => room.gigId === nextId).length, 1, 'One reviewed creation must create one active room.');
    assert.equal(registry.rooms?.some((room: { gigId: string }) => room.gigId === gigId), false, 'The closed room must not become active again.');

    phase = 'restart-server-with-active-and-closed-rooms';
    await restartServer();
    const restoredActive = await readRoom(nextId);
    assert.equal(restoredActive.activeGigId, nextId);
    assert.equal(restoredActive.session?.status, 'active');
    assert.equal(restoredActive.session?.talentName, publicPerformerName);
    assert.equal(restoredActive.session?.paymentsEnabled, false);
    assert.deepEqual(restoredActive.requests, [], 'Restart must not copy completed requests into the active room.');
    assert.deepEqual(restoredActive.session?.totals, nextRoom.session?.totals);
    const stillClosed = await readRoom(gigId);
    assert.equal(stillClosed.session?.status, 'closed');
    assert.equal(stillClosed.activeGigId, gigId);
    assert.equal(stillClosed.room_lookup, 'ended');
    assert.equal(stillClosed.room_read_only, true);
    assert.deepEqual(stillClosed.session?.totals, closed.session?.totals);
    assert.deepEqual(stillClosed.requests, closed.requests);
    await assertClosedHistoryPrivate();
    const restoredRegistryResponse = await performerPage.context().request.get(`${origin.origin}/api/talent/active-rooms`);
    assert.equal(restoredRegistryResponse.status(), 200);
    const restoredRegistry = await restoredRegistryResponse.json();
    assert.deepEqual(restoredRegistry.rooms?.map((room: { gigId: string }) => room.gigId), [nextId], 'Only the new active room belongs in the restored registry.');
    await performerPage.reload({ waitUntil: 'domcontentloaded' });
    await performerPage.getByRole('button', { name: 'Share Room', exact: true }).click();
    const restoredShare = performerPage.locator('[data-sway-performer-room-share="true"]').filter({ visible: true });
    assert.equal(new URL((await restoredShare.getByRole('link', { name: 'Open Room', exact: true }).getAttribute('href'))!, origin.origin).pathname, `/g/${nextId}`, 'Reload must keep the new room selected after server restart.');
    console.log('FREE_ROOM_RESTART_PERSISTENCE_PASS Two new server processes retained owner access, closed history, totals, public privacy and the isolated active room.');
    console.log('FREE_ROOM_LIFECYCLE_PASS Approval, fulfillment, closeout, private recap, reload, reviewed restart and isolated new-room history verified.');
  } catch (error) {
    // The enclosing proof created both accounts and this room in its own local
    // database. Inspect only state labels and visible controls, never credentials.
    const saved = await readRoom(gigId).catch(() => null);
    const headings = await performerPage.locator('h1,h2,h3').allTextContents().catch(() => []);
    const alerts = await performerPage.getByRole('alert').allTextContents().catch(() => []);
    const footer = await performerPage.locator('.sway-live-footer').allTextContents().catch(() => []);
    console.error('FREE_ROOM_LIFECYCLE_FAILURE', JSON.stringify({ phase, savedStatus: saved?.session?.status, selectedRoomMatches: saved?.activeGigId === gigId, headings, alerts, footer }));
    throw error;
  }
}
