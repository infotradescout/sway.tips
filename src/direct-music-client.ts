import { abortable } from "./abortable";
import type {
  DirectMusicOverview,
  MusicCommandAction,
  MusicCommandReceipt,
  MusicConnection,
  MusicDevice,
  MusicPage,
  MusicPlayback,
  MusicPlaylist,
  MusicTrack,
} from "./direct-music";
export class DirectMusicClientError extends Error {
  constructor(
    message: string,
    readonly code = "unavailable",
    readonly retryAfterSeconds = 0,
  ) {
    super(message);
  }
}
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const record = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown, max = 1024) =>
  typeof v === "string" && v.length <= max;
export const isMusicTrack = (v: unknown): v is MusicTrack =>
  record(v) &&
  /^[A-Za-z0-9]{22}$/.test(v.id) &&
  v.uri === "spotify:track:" + v.id &&
  v.url === "https://open.spotify.com/track/" + v.id &&
  string(v.title) &&
  string(v.artist) &&
  typeof v.playable === "boolean" &&
  (v.artwork === null ||
    (string(v.artwork) && v.artwork.startsWith("https://")));
const isPlaylist = (v: unknown): v is MusicPlaylist =>
  record(v) &&
  /^[A-Za-z0-9]{22}$/.test(v.id) &&
  string(v.name) &&
  v.url === "https://open.spotify.com/playlist/" + v.id &&
  (v.artwork === null ||
    (string(v.artwork) && v.artwork.startsWith("https://")));
const isConnection = (v: unknown): v is MusicConnection =>
  record(v) &&
  uuid.test(v.id) &&
  uuid.test(v.revision) &&
  v.provider === "spotify" &&
  string(v.label) &&
  ["connected", "reconnect_required"].includes(v.status) &&
  (v.selectedDeviceId === null || string(v.selectedDeviceId, 512)) &&
  (v.connectedAt === null || Number.isFinite(Date.parse(v.connectedAt)));
const invalid = () =>
  new DirectMusicClientError(
    "Your music connection response could not be confirmed. Refresh to try again.",
    "invalid_response",
  );
export class DirectMusicClient {
  constructor(
    readonly performerId: string,
    private readonly signal: AbortSignal,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}
  private async request(
    path: string,
    body?: unknown,
    allowRejectedCommand = false,
  ): Promise<any> {
    if (this.signal.aborted) throw this.signal.reason;
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(25000)]);
    const response = await abortable(
      this.fetcher("/api/talent/direct-music" + path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        signal,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      }),
      signal,
    );
    const data = await abortable(response.json(), signal).catch((error) => {
      if (signal.aborted) throw error;
      return null;
    });
    if (this.signal.aborted) throw this.signal.reason;
    if (
      !response.ok &&
      !(
        allowRejectedCommand &&
        response.status === 409 &&
        record(data) &&
        data.status === "rejected"
      )
    )
      throw new DirectMusicClientError(
        record(data) && string(data.error)
          ? data.error
          : "Music connection unavailable.",
        record(data) && string(data.code) ? data.code : "unavailable",
        record(data) && Number.isSafeInteger(data.retryAfterSeconds)
          ? Math.max(0, Math.min(86400, data.retryAfterSeconds))
          : 0,
      );
    if (!record(data)) throw invalid();
    return data;
  }
  async overview(): Promise<DirectMusicOverview> {
    const d = await this.request(
      "?" + new URLSearchParams({ performerId: this.performerId }),
    );
    if (
      d.performerId !== this.performerId ||
      d.provider !== "spotify" ||
      !["available", "setup_required", "approval_required"].includes(
        d.availability,
      ) ||
      !Array.isArray(d.connections) ||
      d.connections.length > 1 ||
      !d.connections.every(isConnection)
    )
      throw invalid();
    return d;
  }
  async connect(connection: MusicConnection | null): Promise<string> {
    const d = await this.request("/spotify/connect", {
      performerId: this.performerId,
      expectedConnection: connection
        ? { id: connection.id, revision: connection.revision }
        : null,
    });
    if (
      d.performerId !== this.performerId ||
      !string(d.authorizationUrl, 8192) ||
      !Number.isFinite(Date.parse(d.expiresAt)) ||
      Date.parse(d.expiresAt) <= Date.now()
    )
      throw invalid();
    const u = new URL(d.authorizationUrl);
    if (
      u.origin !== "https://accounts.spotify.com" ||
      u.pathname !== "/authorize" ||
      u.username ||
      u.password ||
      u.hash ||
      u.searchParams.get("response_type") !== "code" ||
      u.searchParams.get("code_challenge_method") !== "S256"
    )
      throw invalid();
    const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
    if (
      redirect.origin !== window.location.origin ||
      redirect.pathname !== "/api/talent/direct-music/spotify/callback" ||
      redirect.search ||
      redirect.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("state") ?? "") ||
      !/^[A-Za-z0-9_-]{43}$/.test(u.searchParams.get("code_challenge") ?? "")
    )
      throw invalid();
    return u.href;
  }
  private async read(
    connection: MusicConnection,
    kind: string,
    extra: Record<string, string> = {},
  ) {
    const d = await this.request(
      "/" +
        connection.id +
        "/read?" +
        new URLSearchParams({
          performerId: this.performerId,
          revision: connection.revision,
          kind,
          ...extra,
        }),
    );
    if (
      d.performerId !== this.performerId ||
      d.connectionId !== connection.id ||
      d.revision !== connection.revision
    )
      throw invalid();
    return d.data;
  }
  async devices(c: MusicConnection): Promise<MusicDevice[]> {
    const d = await this.read(c, "devices");
    if (
      !Array.isArray(d) ||
      d.length > 100 ||
      !d.every(
        (v) =>
          record(v) &&
          string(v.id, 512) &&
          string(v.name) &&
          string(v.type) &&
          typeof v.active === "boolean" &&
          typeof v.restricted === "boolean",
      )
    )
      throw invalid();
    return d;
  }
  async playback(c: MusicConnection): Promise<MusicPlayback> {
    const d = await this.read(c, "playback");
    if (
      !record(d) ||
      !Number.isFinite(Date.parse(d.observedAt)) ||
      Math.abs(Date.now() - Date.parse(d.observedAt)) > 30000 ||
      (d.deviceId !== null && !string(d.deviceId, 512)) ||
      typeof d.playing !== "boolean" ||
      (d.track !== null && !isMusicTrack(d.track)) ||
      !Array.isArray(d.disallowed) ||
      !d.disallowed.every((v: unknown) => string(v, 100))
    )
      throw invalid();
    return d as MusicPlayback;
  }
  async browse(
    c: MusicConnection,
    kind: "playlists" | "playlist" | "saved" | "search",
    offset = 0,
    query = "",
    playlistId = "",
  ): Promise<MusicPage<MusicTrack | MusicPlaylist>> {
    const d = await this.read(c, kind, {
      offset: String(offset),
      query,
      playlistId,
    });
    if (
      !record(d) ||
      !Array.isArray(d.items) ||
      d.items.length > 50 ||
      d.offset !== offset ||
      !Number.isSafeInteger(d.total) ||
      d.total < 0 ||
      (d.nextOffset !== null &&
        (!Number.isSafeInteger(d.nextOffset) || d.nextOffset <= offset)) ||
      !d.items.every(kind === "playlists" ? isPlaylist : isMusicTrack)
    )
      throw invalid();
    return d as MusicPage<MusicTrack | MusicPlaylist>;
  }
  async target(c: MusicConnection, deviceId: string) {
    const d = await this.request("/" + c.id + "/target", {
      performerId: this.performerId,
      revision: c.revision,
      deviceId,
    });
    if (
      d.performerId !== this.performerId ||
      d.connectionId !== c.id ||
      d.revision !== c.revision ||
      d.deviceId !== deviceId
    )
      throw invalid();
  }
  async disconnect(c: MusicConnection) {
    const d = await this.request("/" + c.id + "/disconnect", {
      performerId: this.performerId,
      revision: c.revision,
    });
    if (
      d.performerId !== this.performerId ||
      d.connectionId !== c.id ||
      d.disconnected !== true
    )
      throw invalid();
  }
  async command(
    c: MusicConnection,
    commandId: string,
    action: MusicCommandAction,
    deviceId: string,
    uri?: string,
  ): Promise<MusicCommandReceipt> {
    // A failed transport is never retried. A second deliberate user action gets a new command ID.
    const d = await this.request(
      "/" + c.id + "/commands",
      {
        performerId: this.performerId,
        revision: c.revision,
        commandId,
        action,
        deviceId,
        ...(uri ? { uri } : {}),
      },
      true,
    );
    if (
      d.id !== commandId ||
      !["in_flight", "accepted", "uncertain", "rejected"].includes(d.status) ||
      !string(d.message) ||
      typeof d.replay !== "boolean"
    )
      throw invalid();
    return d;
  }
}
