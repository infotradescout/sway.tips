import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PerformerAudienceScreen, {
  resolvePerformerAudienceMoments
} from '../src/components/PerformerAudienceScreen';
import { resolvePausedRequestToast } from '../src/components/PatronView';
import {
  LIVE_ROOM_ACTION_SLASH,
  LIVE_ROOM_LANGUAGE,
  resolveLiveRoomModeCopy
} from '../src/live-room-language';
import type { GigSession, RequestItem } from '../src/types';

function requestFixture(input: Partial<RequestItem> & Pick<RequestItem, 'id' | 'title' | 'status'>): RequestItem {
  return {
    type: 'request',
    targetType: 'music',
    subtitle: '',
    senderName: 'QA patron',
    amount: 0,
    holdAmount: 0,
    platformFee: 0,
    sponsorCount: 1,
    shadowBanned: false,
    createdAt: '2026-08-09T20:00:00.000Z',
    boosts: [],
    ...input
  };
}

const played = requestFixture({ id: 'played', title: 'Played Song', status: 'fulfilled' });
const queued = requestFixture({ id: 'queued', title: 'Queued Song', status: 'approved' });
const queuedAfter = requestFixture({ id: 'queued-after', title: 'Later Song', status: 'approved' });

const moments = resolvePerformerAudienceMoments(played, [queued, queuedAfter]);
assert.equal(moments.nowPlaying, played, 'Now Playing must come from fulfilled history.');
assert.equal(moments.upNext, queued, 'Up Next must be the first approved request.');

assert.deepEqual(resolveLiveRoomModeCopy('manual'), {
  label: 'Live',
  queueLabel: 'Performer-approved queue'
});
assert.deepEqual(resolveLiveRoomModeCopy('open_call'), {
  label: 'Open Call',
  queueLabel: 'Performer-approved queue'
});
assert.deepEqual(resolveLiveRoomModeCopy('crowd_autopilot'), {
  label: 'Crowd Autopilot',
  queueLabel: 'Crowd-ranked queue'
});

assert.equal(
  resolvePausedRequestToast(true),
  'Requests are paused by the host. You can still send a Direct Tip.'
);
assert.equal(
  resolvePausedRequestToast(false),
  'Requests are paused by the host. Try again when requests reopen.'
);

const baseSession = {
  operatingMode: 'manual',
  requestsOpen: true
} as GigSession;

const manualMarkup = renderToStaticMarkup(
  <PerformerAudienceScreen
    activeGigId={null}
    session={baseSession}
    nowPlayingRequest={played}
    approvedQueue={[queued, queuedAfter]}
  />
);

for (const renderedCopy of [
  LIVE_ROOM_LANGUAGE.nowPlaying,
  played.title,
  LIVE_ROOM_LANGUAGE.upNext,
  queued.title,
  LIVE_ROOM_ACTION_SLASH,
  'Performer-approved queue'
]) {
  assert.ok(manualMarkup.includes(renderedCopy), `Audience Screen must render ${renderedCopy}.`);
}

const crowdMarkup = renderToStaticMarkup(
  <PerformerAudienceScreen
    activeGigId={null}
    session={{ ...baseSession, operatingMode: 'crowd_autopilot' }}
    nowPlayingRequest={null}
    approvedQueue={[queued]}
  />
);
assert.ok(crowdMarkup.includes('Crowd Autopilot'));
assert.ok(crowdMarkup.includes('Crowd-ranked queue'));
assert.ok(crowdMarkup.includes('Waiting for the performer'));

console.log('Sway app unification behavior test passed.');
