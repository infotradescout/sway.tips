// TEST ONLY. Isolated provider boundary for the actual app's direct-connection flow.
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
assert.equal(process.env.NODE_ENV, "test");
assert.equal(process.env.SWAY_SPOTIFY_CLIENT_ID, "a".repeat(32));
const file = process.env.SWAY_DIRECT_MUSIC_FIXTURE;
assert(file && file.includes("sway-direct-music-fixture-"));
const read = () => JSON.parse(readFileSync(file, "utf8"));
function patch(values) {
  const tmp = file + "." + randomUUID();
  writeFileSync(tmp, JSON.stringify({ ...read(), ...values }));
  renameSync(tmp, file);
}
const json = (value, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers });
const realFetch = globalThis.fetch;
const id = "4uLU6hMCjMI75M1A2tKUQC",
  otherId = "7qiZfU4dY1lWllzX7mPBI3",
  playlistId = "37i9dQZF1DXcBWIGoYBM5M";
const track = (idValue = id) => ({
  id: idValue,
  name: idValue === id ? "Fixture first song" : "Fixture next song",
  type: "track",
  artists: [{ name: "Fixture artist" }],
  album: { images: [] },
});
const scopes =
  "user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative user-library-read";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (["127.0.0.1", "localhost"].includes(url.hostname))
    return realFetch(input, init);
  assert(
    ["https://accounts.spotify.com", "https://api.spotify.com"].includes(
      url.origin,
    ),
    "External network is forbidden in direct music proof",
  );
  assert.equal(init.redirect, "error");
  assert(init.signal);
  const config = read(),
    method = init.method ?? "GET";
  appendFileSync(
    file + ".requests",
    JSON.stringify({
      path: url.pathname,
      query: url.search,
      method,
      time: Date.now(),
    }) + "\n",
  );
  if (url.pathname === "/api/token") {
    const form = new URLSearchParams(String(init.body));
    assert.equal(form.get("client_id"), "a".repeat(32));
    if (form.get("grant_type") === "authorization_code") {
      assert.equal(form.get("code"), config.code);
      assert.equal(form.get("redirect_uri"), config.redirectUri);
      assert.equal(
        createHash("sha256")
          .update(form.get("code_verifier"))
          .digest("base64url"),
        config.challenge,
      );
    } else {
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "fixture-refresh");
    }
    return json({
      access_token: "fixture-token",
      refresh_token: "fixture-refresh",
      token_type: "Bearer",
      expires_in: 3600,
      scope: scopes,
    });
  }
  assert.equal(
    new Headers(init.headers).get("Authorization"),
    "Bearer fixture-token",
  );
  if (config.fail === "revoked") return json({}, 401);
  if (config.fail === "rate") return json({}, 429, { "Retry-After": "2" });
  if (url.pathname === "/v1/me")
    return json({
      id: "fixture-public-user",
      account_id: "fixture-listener",
      display_name: "Connected fixture listener",
    });
  if (url.pathname === "/v1/me/player/devices")
    return json({
      devices: config.noDevices
        ? []
        : [
            {
              id: "fixture-laptop",
              name: "Fixture laptop",
              type: "computer",
              is_active: true,
              is_restricted: false,
            },
            {
              id: "fixture-restricted",
              name: "Unavailable speaker",
              type: "speaker",
              is_active: false,
              is_restricted: true,
            },
          ],
    });
  if (url.pathname === "/v1/me/player" && method === "GET") {
    if (config.stateFailure) return json({}, 503);
    return json({
      device: { id: "fixture-laptop" },
      is_playing: config.playing === true,
      progress_ms: 1000,
      item: config.currentTrack ? track(config.currentTrack) : null,
      actions: { disallows: {} },
    });
  }
  if (url.pathname === "/v1/me/playlists")
    return json({
      items: [
        {
          id: playlistId,
          name: config.playlistName ?? "My connected playlist",
          images: [],
        },
      ],
      offset: 0,
      total: 1,
      next: null,
    });
  if (url.pathname === "/v1/playlists/" + playlistId + "/items")
    return json({
      items: [{ item: track() }, { item: track(otherId) }],
      offset: 0,
      total: 2,
      next: null,
    });
  if (url.pathname === "/v1/me/tracks")
    return json({
      items: [{ track: track() }],
      offset: 0,
      total: 1,
      next: null,
    });
  if (url.pathname === "/v1/search") {
    assert.equal(url.searchParams.get("limit"), "10");
    return json({
      tracks: { items: [track()], offset: 0, total: 1, next: null },
    });
  }
  if (url.pathname.startsWith("/v1/me/player") && method !== "GET") {
    if (url.pathname !== "/v1/me/player")
      assert.equal(url.searchParams.get("device_id"), "fixture-laptop");
    if (config.fail === "command_rejected") return json({}, 403);
    if (url.pathname.endsWith("/play")) {
      const body = init.body ? JSON.parse(init.body) : null;
      if (!config.holdState)
        patch({
          playing: true,
          currentTrack:
            body?.uris?.[0]?.split(":")[2] ?? config.currentTrack ?? id,
        });
    }
    if (url.pathname.endsWith("/pause")) patch({ playing: false });
    if (url.pathname.endsWith("/next")) patch({ currentTrack: otherId });
    if (url.pathname === "/v1/me/player") {
      assert.deepEqual(JSON.parse(init.body), {
        device_ids: ["fixture-laptop"],
        play: false,
      });
    }
    if (config.fail === "lost_command")
      throw new Error(
        "Simulated response loss after provider received the command.",
      );
    return new Response(null, { status: 204 });
  }
  throw new Error("Unexpected provider path " + url.pathname);
};
