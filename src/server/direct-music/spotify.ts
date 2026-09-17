import { abortable } from "../../abortable";
import type {
  MusicCommandAction,
  MusicDevice,
  MusicPage,
  MusicPlayback,
  MusicPlaylist,
  MusicTrack,
} from "../../direct-music";
import { MusicFailure } from "./security";
export const SPOTIFY_SCOPES = [
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
];
export type SpotifyTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
};
type ObjectValue = Record<string, any>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const idPattern = /^[a-zA-Z0-9]{22}$/;
const text = (value: unknown, max = 300) =>
  typeof value === "string" ? value.slice(0, max) : "";
function image(value: unknown): string | null {
  try {
    const u = new URL(String(value));
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
function invalid(): never {
  throw new MusicFailure(
    502,
    "invalid_provider_response",
    "The music service returned an incomplete response. Refresh to try again.",
  );
}
function providerFailure(response: Response, token: boolean): MusicFailure {
  if (response.status === 429) {
    const raw = response.headers.get("retry-after") ?? "";
    const delay = /^\d+$/.test(raw)
      ? Number(raw)
      : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
    return new MusicFailure(
      429,
      "rate_limited",
      "Spotify is busy. Wait before trying again.",
      Number.isFinite(delay) ? Math.max(1, Math.min(86400, delay)) : 5,
    );
  }
  if (
    response.status === 401 ||
    (token && [400, 403].includes(response.status))
  )
    return new MusicFailure(
      409,
      "reconnect_required",
      "Spotify authorization expired or was revoked. Reconnect your account.",
    );
  if (response.status === 403)
    return new MusicFailure(
      403,
      "provider_access_denied",
      "Spotify did not allow this action. Check Premium eligibility, granted permissions, and the selected player.",
    );
  if (response.status === 404)
    return new MusicFailure(
      409,
      "provider_unavailable",
      "This music or playback device is unavailable. Refresh your library and players.",
    );
  return new MusicFailure(
    502,
    "provider_unavailable",
    "Spotify could not complete this request.",
  );
}
export function normalizeTrack(value: unknown): MusicTrack | null {
  if (
    value === null ||
    (object(value) && (value.is_local === true || value.type === "episode"))
  )
    return null;
  if (
    !object(value) ||
    !idPattern.test(value.id) ||
    typeof value.name !== "string" ||
    !Array.isArray(value.artists)
  )
    return invalid();
  return {
    id: value.id,
    uri: "spotify:track:" + value.id,
    title: text(value.name),
    artist: value.artists
      .map((a: unknown) => (object(a) ? text(a.name) : ""))
      .filter(Boolean)
      .join(", "),
    artwork: image(value.album?.images?.[0]?.url),
    url: "https://open.spotify.com/track/" + value.id,
    playable: value.is_playable !== false && !value.restrictions?.reason,
  };
}
export class SpotifyDirectProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async request(
    url: URL,
    init: RequestInit,
    tokenExchange = false,
  ): Promise<unknown> {
    if (
      !["https://api.spotify.com", "https://accounts.spotify.com"].includes(
        url.origin,
      ) ||
      url.username ||
      url.password
    )
      throw new Error("Provider destination rejected");
    const signal = AbortSignal.timeout(8000);
    try {
      // Read and mutation calls never follow redirects. Mutation retries are never implicit.
      const response = await abortable(
        this.fetcher(url, { ...init, signal, redirect: "error" }),
        signal,
      );
      if (!response.ok) throw providerFailure(response, tokenExchange);
      if (response.status === 204) return null;
      if (Number(response.headers.get("content-length")) > 2_000_000)
        return invalid();
      const reader = response.body?.getReader();
      if (!reader) return invalid();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await abortable(reader.read(), signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2_000_000) {
            await reader.cancel();
            return invalid();
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!object(data)) return invalid();
      return data;
    } catch (error) {
      if (error instanceof MusicFailure) throw error;
      throw new MusicFailure(
        502,
        signal.aborted ? "provider_timeout" : "provider_unavailable",
        signal.aborted
          ? "The music service did not respond in time. Check its current state before repeating an action."
          : "The music service response could not be confirmed.",
      );
    }
  }
  async tokens(
    clientId: string,
    fields: Record<string, string>,
    previous?: SpotifyTokens,
  ): Promise<SpotifyTokens> {
    const data = await this.request(
      new URL("https://accounts.spotify.com/api/token"),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: clientId, ...fields }),
      },
      true,
    );
    if (
      !object(data) ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      data.access_token.length > 8192 ||
      data.token_type?.toLowerCase() !== "bearer" ||
      !Number.isSafeInteger(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400
    )
      return invalid();
    const refresh =
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : previous?.refreshToken;
    const scopes =
      typeof data.scope === "string"
        ? data.scope.split(/\s+/).filter(Boolean)
        : previous?.scopes;
    if (
      !refresh ||
      refresh.length > 8192 ||
      !scopes ||
      SPOTIFY_SCOPES.some((scope) => !scopes.includes(scope))
    )
      throw new MusicFailure(
        409,
        "reconnect_required",
        "The required music permissions were not granted. Reconnect and review the requested permissions.",
      );
    return {
      accessToken: data.access_token,
      refreshToken: refresh,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes,
    };
  }
  private api(
    accessToken: string,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error("Invalid Spotify path");
    const url = new URL("https://api.spotify.com/v1" + path);
    return this.request(url, {
      method,
      headers: {
        Authorization: "Bearer " + accessToken,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async profile(token: string): Promise<{ id: string; label: string }> {
    const data = await this.api(token, "/me");
    if (
      !object(data) ||
      typeof data.id !== "string" ||
      !data.id ||
      data.id.length > 256
    )
      return invalid();
    // GET /me no longer guarantees product, email or country in 2026 Development Mode.
    return { id: data.id, label: text(data.display_name) || data.id };
  }
  async devices(token: string): Promise<MusicDevice[]> {
    const data = await this.api(token, "/me/player/devices");
    if (
      !object(data) ||
      !Array.isArray(data.devices) ||
      data.devices.length > 100
    )
      return invalid();
    return data.devices.map((d: unknown) => {
      if (
        !object(d) ||
        typeof d.name !== "string" ||
        typeof d.is_restricted !== "boolean" ||
        typeof d.is_active !== "boolean"
      )
        return invalid();
      return {
        id: typeof d.id === "string" ? d.id : "",
        name: text(d.name),
        type: text(d.type),
        active: d.is_active,
        restricted: d.is_restricted || typeof d.id !== "string" || !d.id,
      };
    });
  }
  async playback(token: string): Promise<MusicPlayback> {
    const data = await this.api(token, "/me/player");
    if (data === null)
      return {
        observedAt: new Date().toISOString(),
        deviceId: null,
        playing: false,
        progressMs: null,
        track: null,
        disallowed: [],
      };
    if (
      !object(data) ||
      typeof data.is_playing !== "boolean" ||
      !object(data.device)
    )
      return invalid();
    return {
      observedAt: new Date().toISOString(),
      deviceId: typeof data.device.id === "string" ? data.device.id : null,
      playing: data.is_playing,
      progressMs: Number.isFinite(data.progress_ms) ? data.progress_ms : null,
      track: normalizeTrack(data.item ?? null),
      disallowed: object(data.actions?.disallows)
        ? Object.keys(data.actions.disallows).filter(
            (k) => data.actions.disallows[k] === true,
          )
        : [],
    };
  }
  async browse(
    token: string,
    kind: "playlists" | "playlist" | "saved" | "search",
    offset: number,
    query = "",
    playlistId = "",
  ): Promise<MusicPage<MusicTrack | MusicPlaylist>> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      throw new MusicFailure(422, "invalid_request", "Invalid library page.");
    const limit = kind === "search" ? 10 : 50;
    const args = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    let path = "/me/playlists";
    if (kind === "saved") path = "/me/tracks";
    if (kind === "search") {
      if (!query.trim() || query.length > 200)
        throw new MusicFailure(
          422,
          "invalid_request",
          "Enter a search of up to 200 characters.",
        );
      path = "/search";
      args.set("type", "track");
      args.set("q", query.trim());
    }
    if (kind === "playlist") {
      if (!idPattern.test(playlistId))
        throw new MusicFailure(
          422,
          "invalid_request",
          "Choose a valid playlist.",
        );
      path = "/playlists/" + playlistId + "/items";
    }
    const result = await this.api(token, path + "?" + args);
    const page = kind === "search" && object(result) ? result.tracks : result;
    if (
      !object(page) ||
      !Array.isArray(page.items) ||
      page.offset !== offset ||
      !Number.isSafeInteger(page.total) ||
      page.total < offset + page.items.length ||
      page.items.length > limit ||
      !(page.next === null || typeof page.next === "string")
    )
      return invalid();
    let nextOffset: number | null = null;
    if (page.next !== null) {
      const next = new URL(page.next);
      if (
        next.origin !== "https://api.spotify.com" ||
        next.pathname !== "/v1" + path ||
        next.username ||
        next.password ||
        next.hash ||
        !page.items.length ||
        Number(next.searchParams.get("offset")) !==
          offset + page.items.length ||
        offset + page.items.length >= page.total
      )
        return invalid();
      nextOffset = offset + page.items.length;
    }
    if (nextOffset === null && offset + page.items.length < page.total)
      return invalid();
    const items = page.items
      .map((row: unknown) => {
        if (kind === "playlists") {
          if (
            !object(row) ||
            !idPattern.test(row.id) ||
            typeof row.name !== "string"
          )
            return invalid();
          return {
            id: row.id,
            name: text(row.name),
            url: "https://open.spotify.com/playlist/" + row.id,
            artwork: image(row.images?.[0]?.url),
          };
        }
        return normalizeTrack(
          kind === "search"
            ? row
            : object(row)
              ? "item" in row
                ? row.item
                : row.track
              : undefined,
        );
      })
      .filter(
        (
          row: MusicTrack | MusicPlaylist | null,
        ): row is MusicTrack | MusicPlaylist => row !== null,
      );
    return { items, offset, nextOffset, total: page.total };
  }
  async command(
    token: string,
    action: MusicCommandAction,
    deviceId: string,
    uri?: string,
  ): Promise<void> {
    const args = new URLSearchParams({ device_id: deviceId });
    if (typeof deviceId !== "string" || !deviceId || deviceId.length > 512)
      throw new MusicFailure(
        422,
        "invalid_request",
        "Select a playback device.",
      );
    if (
      ["play", "queue"].includes(action) &&
      !/^spotify:track:[a-zA-Z0-9]{22}$/.test(uri ?? "")
    )
      throw new MusicFailure(
        422,
        "invalid_request",
        "Choose an available Spotify track.",
      );
    if (action === "transfer") {
      await this.api(token, "/me/player", "PUT", {
        device_ids: [deviceId],
        play: false,
      });
      return;
    }
    if (action === "queue") {
      args.set("uri", uri!);
      await this.api(token, "/me/player/queue?" + args, "POST");
      return;
    }
    const endpoint = action === "resume" ? "play" : action;
    if (!["play", "pause", "next", "previous"].includes(endpoint))
      throw new MusicFailure(
        422,
        "invalid_request",
        "This playback action is not supported.",
      );
    await this.api(
      token,
      "/me/player/" + endpoint + "?" + args,
      ["next", "previous"].includes(endpoint) ? "POST" : "PUT",
      action === "play" ? { uris: [uri] } : undefined,
    );
  }
}
