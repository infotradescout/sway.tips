export type MusicCommandAction =
  | "play"
  | "resume"
  | "pause"
  | "next"
  | "previous"
  | "queue"
  | "transfer";
export type MusicTrack = {
  id: string;
  uri: string;
  title: string;
  artist: string;
  artwork: string | null;
  url: string;
  playable: boolean;
};
export type MusicPlaylist = {
  id: string;
  name: string;
  url: string;
  artwork: string | null;
};
export type MusicDevice = {
  id: string;
  name: string;
  type: string;
  active: boolean;
  restricted: boolean;
};
export type MusicPlayback = {
  observedAt: string;
  deviceId: string | null;
  playing: boolean;
  progressMs: number | null;
  track: MusicTrack | null;
  disallowed: string[];
};
export type MusicConnection = {
  id: string;
  provider: "spotify";
  label: string;
  revision: string;
  selectedDeviceId: string | null;
  status: "connected" | "reconnect_required";
  connectedAt: string | null;
};
export type MusicCommandReceipt = {
  id: string;
  status: "in_flight" | "accepted" | "uncertain" | "rejected";
  code: string | null;
  message: string;
  replay: boolean;
};
export type DirectMusicOverview = {
  performerId: string;
  provider: "spotify";
  availability: "available" | "setup_required" | "approval_required";
  connections: MusicConnection[];
};
export type MusicPage<T> = {
  items: T[];
  offset: number;
  nextOffset: number | null;
  total: number;
};
