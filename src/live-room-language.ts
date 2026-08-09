export const LIVE_ROOM_LANGUAGE = {
  liveRoom: 'Live Room',
  requests: 'Requests',
  request: 'Request',
  tip: 'Tip',
  boost: 'Boost',
  pending: 'Pending',
  approved: 'Approved',
  nowPlaying: 'Now Playing',
  upNext: 'Up Next',
  paused: 'Paused',
  ended: 'Ended',
  roomStatus: 'Room status',
  requestSource: 'Request source',
  directTip: 'Direct Tip',
  audienceScreen: 'Audience Screen',
  audienceRoom: 'Audience Room',
  roomScreen: 'Room Screen',
  shareRoom: 'Share Room',
  copyRoomLink: 'Copy Room Link',
  openRoom: 'Open Room',
  copyRoomScreen: 'Copy Room Screen',
  openRoomScreen: 'Open Room Screen',
  pauseRequests: 'Pause Requests',
  resumeRequests: 'Resume Requests',
  endRoom: 'End Room',
  roomRecap: 'Room Recap',
  controls: 'Controls'
} as const;

export const LIVE_ROOM_ACTIONS = [
  LIVE_ROOM_LANGUAGE.request,
  LIVE_ROOM_LANGUAGE.tip,
  LIVE_ROOM_LANGUAGE.boost
] as const;

export const LIVE_ROOM_ACTION_LIST = `${LIVE_ROOM_ACTIONS[0]}, ${LIVE_ROOM_ACTIONS[1]}, and ${LIVE_ROOM_ACTIONS[2]}`;
export const LIVE_ROOM_ACTION_SLASH = LIVE_ROOM_ACTIONS.join(' / ');

export type LiveRoomOperatingMode = 'manual' | 'open_call' | 'crowd_autopilot';

export function resolveLiveRoomModeCopy(mode: LiveRoomOperatingMode) {
  if (mode === 'crowd_autopilot') {
    return { label: 'Crowd Autopilot', queueLabel: 'Crowd-ranked queue' } as const;
  }
  if (mode === 'open_call') {
    return { label: 'Open Call', queueLabel: 'Performer-approved queue' } as const;
  }
  return { label: 'Live', queueLabel: 'Performer-approved queue' } as const;
}
