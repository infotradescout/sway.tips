export type NativeConnection = {
  id: string; revision: string; targetKey: string; program: string; deck: number; label: string;
  actions: string[]; uncertain: boolean; pendingReview: Array<{ id: string; action: string; finishedAt: string }>;
};
export type NativeState = {
  playing: boolean; trackTitle: string | null; trackArtist: string | null;
  positionMs: number | null; durationMs: number | null; observedAt: string;
};
export function parseNativeConnection(value: unknown): NativeConnection;
export class NativePlayerClient {
  constructor(options: { pairingKey: string; port?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number });
  list(): Promise<NativeConnection[]>;
  state(connection: NativeConnection): Promise<NativeState>;
  command(connection: NativeConnection, command: { id: string; action: string }): Promise<{ id: string; accepted: boolean; uncertain: boolean; replay: boolean }>;
  reconnect(connection: NativeConnection): Promise<NativeConnection>;
  review(connection: NativeConnection, id: string): Promise<{ id: string; replayed: false; reviewedAt: string }>;
}
