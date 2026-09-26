import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import { createSwayDb } from "../src/db/client";
import {
  users,
  performers,
  performerLibrarySources,
  directMusicCredentials as credentials,
  directMusicOAuthAttempts as attempts,
  directMusicCommands as commands,
  performerMusicSourceConnections as connections,
} from "../src/db/schema";
import { startEmbeddedPostgresProof } from "./lib/embedded-postgres-proof";
import { DirectMusicService } from "../src/server/direct-music/service";
import {
  SpotifyDirectProvider,
  SPOTIFY_SCOPES,
  type SpotifyTokens,
} from "../src/server/direct-music/spotify";
import {
  availability,
  digest,
  encryptionKey,
  MusicFailure,
  seal,
  unseal,
} from "../src/server/direct-music/security";
import { createDirectMusicRouter } from "../src/server/direct-music/routes";

const proof = await startEmbeddedPostgresProof("direct_music");
const db = createSwayDb(proof.databaseUrl);
const actor = randomUUID(),
  other = randomUUID(),
  performerId = randomUUID(),
  otherPerformer = randomUUID(),
  scope = { actorId: actor, performerId };
const env: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  SWAY_APP_BASE_URL: "http://127.0.0.1:32101",
  SWAY_SPOTIFY_CLIENT_ID: "a".repeat(32),
  SWAY_MUSIC_TOKEN_KEY: Buffer.alloc(32, 7).toString("base64"),
  SWAY_SPOTIFY_DIRECT_USE_APPROVED: "true",
  SWAY_SPOTIFY_DIRECT_APPROVAL_REFERENCE:
    "synthetic-test-fixture-only-not-provider-approval",
};
const calls: { path: string; method: string; query: string; body: string }[] =
  [];
let tokens = 0,
  actions = 0,
  mode = "normal",
  label = "Original playlist",
  profileId = "spotify-test-owner",
  publicProfileId = "mutable-public-owner";
let player = {
  device: { id: "test-laptop" },
  is_playing: false,
  progress_ms: 0,
  item: null as any,
  actions: { disallows: {} },
};
const trackId = "4uLU6hMCjMI75M1A2tKUQC",
  secondTrack = "7qiZfU4dY1lWllzX7mPBI3",
  playlistId = "37i9dQZF1DXcBWIGoYBM5M";
const track = (id = trackId) => ({
  id,
  type: "track",
  name: "Synthetic Song " + id,
  artists: [{ name: "Test Artist" }],
  album: { images: [] },
});
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const deviceList = () => ({
  devices: [
    {
      id: "test-laptop",
      name: "Test laptop",
      type: "computer",
      is_active: true,
      is_restricted: false,
    },
    {
      id: "restricted-speaker",
      name: "Restricted speaker",
      type: "speaker",
      is_active: false,
      is_restricted: true,
    },
  ],
});
let onProfile: (() => Promise<void>) | null = null;
const provider = new SpotifyDirectProvider((async (input, init) => {
  const url = new URL(String(input));
  assert(
    ["https://api.spotify.com", "https://accounts.spotify.com"].includes(
      url.origin,
    ),
  );
  assert.equal(init?.redirect, "error");
  assert(init?.signal);
  const method = init?.method ?? "GET",
    body = String(init?.body ?? "");
  calls.push({ path: url.pathname, method, query: url.search, body });
  if (url.pathname === "/api/token") {
    tokens++;
    const form = new URLSearchParams(body);
    assert.equal(form.get("client_id"), env.SWAY_SPOTIFY_CLIENT_ID);
    assert(
      ["authorization_code", "refresh_token"].includes(form.get("grant_type")!),
    );
    if (mode === "missing_scope")
      return json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "user-read-private",
      });
    if (mode === "bad_refresh") return json({}, 400);
    return json({
      access_token: "synthetic-access-" + tokens,
      ...(form.get("grant_type") === "refresh_token"
        ? {}
        : { refresh_token: "synthetic-refresh" }),
      token_type: "Bearer",
      expires_in: 3600,
      scope: SPOTIFY_SCOPES.join(" "),
    });
  }
  assert.match(
    new Headers(init?.headers).get("authorization") ?? "",
    /^Bearer synthetic-access/,
  );
  if (mode === "rate_limited") return json({}, 429, { "Retry-After": "7" });
  if (mode === "revoked") return json({}, 401);
  if (url.pathname === "/v1/me") {
    if (onProfile) await onProfile();
    return json({ id: publicProfileId, account_id: profileId, display_name: "Connected test listener" });
  }
  if (url.pathname === "/v1/me/player/devices") return json(deviceList());
  if (url.pathname === "/v1/me/player" && method === "GET")
    return mode === "empty_player"
      ? new Response(null, { status: 204 })
      : json(player);
  if (url.pathname === "/v1/me/playlists")
    return json({
      items: [{ id: playlistId, name: label, images: [] }],
      total: 1,
      offset: 0,
      next: null,
    });
  if (url.pathname === "/v1/me/tracks")
    return json({
      items: [{ track: track() }],
      total: 1,
      offset: 0,
      next: null,
    });
  if (url.pathname.endsWith("/items"))
    return json({
      items: [{ item: track() }],
      total: 1,
      offset: 0,
      next: null,
    });
  if (url.pathname === "/v1/search") {
    assert.equal(url.searchParams.get("limit"), "10");
    return json({
      tracks: { items: [track()], total: 1, offset: 0, next: null },
    });
  }
  if (url.pathname.startsWith("/v1/me/player") && method !== "GET") {
    actions++;
    if (mode === "lost_response")
      throw new Error("Synthetic response loss; never resend");
    if (url.pathname.endsWith("/play")) {
      player.is_playing = true;
      player.item = body
        ? track(JSON.parse(body).uris[0].split(":")[2])
        : player.item;
    }
    if (url.pathname.endsWith("/pause")) player.is_playing = false;
    if (url.pathname.endsWith("/next")) player.item = track(secondTrack);
    return new Response(null, { status: 204 });
  }
  throw new Error("Unexpected mocked provider path " + url.pathname);
}) as typeof fetch);
const service = new DirectMusicService(db, env, provider);
async function connect(
  expected: { id: string; revision: string } | null = null,
) {
  const started = await service.begin(scope, expected);
  return service.finish(
    actor,
    new URL(started.url).searchParams.get("state")!,
    started.browser,
    "synthetic-code",
  );
}
async function current() {
  return (await service.overview(scope)).connections[0];
}
async function row() {
  return (
    await db
      .select()
      .from(credentials)
      .where(eq(credentials.performerId, performerId))
  )[0];
}
const rejects = (work: () => Promise<unknown>, code: string) =>
  assert.rejects(
    work,
    (error: unknown) => error instanceof MusicFailure && error.code === code,
  );
await db.insert(users).values([
  { id: actor, email: "direct-owner@example.test", displayName: "Owner" },
  { id: other, email: "direct-other@example.test", displayName: "Other" },
]);
await db.insert(performers).values([
  {
    id: performerId,
    ownerUserId: actor,
    displayName: "Direct Music Owner",
    handle: "direct-owner",
  },
  {
    id: otherPerformer,
    ownerUserId: other,
    displayName: "Other",
    handle: "direct-other",
  },
]);
await db
  .insert(performerLibrarySources)
  .values({
    performerId,
    sourceKey: "legacy-untouched",
    sourceLabel: "Existing song list",
    syncKeyHash: "synthetic-hash",
    syncKeyPreview: "file-import",
  });
let server: ReturnType<typeof express>["listen"] extends (
  ...args: any
) => infer R
  ? R
  : never;

try {
  await test("Direct account connection and external control: actual store/router, synthetic provider", async (t) => {
    await t.test(
      "provider approval and key configuration are independent fail-closed requirements",
      async () => {
        assert.equal(
          availability({ ...env, SWAY_SPOTIFY_DIRECT_USE_APPROVED: "" }),
          "approval_required",
        );
        assert.equal(
          availability({ ...env, SWAY_MUSIC_TOKEN_KEY: "bad" }),
          "setup_required",
        );
        await rejects(
          () =>
            new DirectMusicService(
              db,
              { ...env, SWAY_SPOTIFY_DIRECT_USE_APPROVED: "" },
              provider,
            ).begin(scope, null),
          "approval_required",
        );
        assert.equal(calls.length, 0);
      },
    );
    await t.test(
      "a different account cannot inspect or begin another performer connection",
      async () => {
        await rejects(
          () => service.overview({ actorId: other, performerId }),
          "account_changed",
        );
        await rejects(
          () => service.begin({ actorId: other, performerId }, null),
          "account_changed",
        );
        assert.equal(calls.length, 0);
      },
    );
    let initial: Awaited<ReturnType<typeof service.begin>>;
    await t.test(
      "PKCE and browser binding are generated, with only hashes and encrypted verifier stored",
      async () => {
        initial = await service.begin(scope, null);
        const url = new URL(initial.url),
          state = url.searchParams.get("state")!;
        assert.equal(url.origin, "https://accounts.spotify.com");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        assert.equal(
          url.searchParams.get("redirect_uri"),
          env.SWAY_APP_BASE_URL + "/api/talent/direct-music/spotify/callback",
        );
        const [attempt] = await db.select().from(attempts);
        assert.equal(attempt.stateHash, digest(state));
        assert.equal(attempt.browserHash, digest(initial.browser));
        assert(!JSON.stringify(attempt).includes(state));
        assert(attempt.sealedVerifier.startsWith("v1."));
      },
    );
    await t.test(
      "foreign callback identity and browser nonce fail before token exchange",
      async () => {
        const state = new URL(initial.url).searchParams.get("state")!;
        await rejects(
          () => service.finish(other, state, initial.browser, "code"),
          "oauth_expired",
        );
        await rejects(
          () => service.finish(actor, state, "x".repeat(43), "code"),
          "oauth_expired",
        );
        assert.equal(tokens, 0);
      },
    );
    await t.test(
      "successful authorization stores an encrypted, account-bound reusable connection",
      async () => {
        await service.finish(
          actor,
          new URL(initial.url).searchParams.get("state")!,
          initial.browser,
          "code",
        );
        const c = await current(),
          secret = await row();
        assert(c.id && c.revision && c.status === "connected");
        const [identity] = await db.select().from(connections).where(eq(connections.id, c.id));
        assert.equal(identity.externalAccountId, profileId);
        assert.notEqual(identity.externalAccountId, publicProfileId);
        assert.equal(c.selectedDeviceId, null);
        assert(!secret.sealedTokens.includes("synthetic-access"));
        assert.equal((await db.select().from(attempts)).length, 0);
        assert(
          !JSON.stringify(await service.overview(scope)).includes("Token"),
        );
        assert(
          !JSON.stringify(await service.overview(scope)).includes("refresh"),
        );
        assert.throws(
          () =>
            unseal(
              secret.sealedTokens,
              encryptionKey(env),
              "different-owner-context",
            ),
          /Reconnect/,
        );
      },
    );
    await t.test(
      "a consumed callback cannot exchange or overwrite again",
      async () => {
        const before = tokens;
        await rejects(
          () =>
            service.finish(
              actor,
              new URL(initial.url).searchParams.get("state")!,
              initial.browser,
              "code",
            ),
          "oauth_expired",
        );
        assert.equal(tokens, before);
      },
    );
    await t.test(
      "service restart reuses the saved connection, not an uploaded catalog",
      async () => {
        const another = new DirectMusicService(db, env, provider);
        assert.deepEqual(
          await another.overview(scope),
          await service.overview(scope),
        );
      },
    );
    await t.test(
      "library changes arrive directly from the provider without a file or stored-track replacement",
      async () => {
        const c = await current();
        let result = await service.read(scope, c.id, c.revision, "playlists");
        assert.equal((result.data as any).items[0].name, "Original playlist");
        label = "Provider edited playlist";
        result = await service.read(scope, c.id, c.revision, "playlists");
        assert.equal((result.data as any).items[0].name, label);
        assert.equal(
          (await db.select().from(performerLibrarySources)).length,
          1,
        );
        for (const kind of ["playlist", "saved", "search"] as const) {
          const result = await service.read(
            scope,
            c.id,
            c.revision,
            kind,
            0,
            "Synthetic",
            playlistId,
          );
          assert.equal(
            (result.data as any).items[0].uri,
            "spotify:track:" + trackId,
          );
        }
      },
    );
    await t.test(
      "restricted or missing players are not selectable; selecting a player does not play",
      async () => {
        const c = await current();
        await rejects(
          () => service.target(scope, c.id, c.revision, "restricted-speaker"),
          "device_unavailable",
        );
        await rejects(
          () => service.target(scope, c.id, c.revision, "missing"),
          "device_unavailable",
        );
        await service.target(scope, c.id, c.revision, "test-laptop");
        assert.equal(actions, 0);
        assert.equal((await current()).selectedDeviceId, "test-laptop");
      },
    );
    let successfulCommand: string;
    await t.test(
      "Play reaches the chosen provider device; receipt is accepted, never a fabricated playing state",
      async () => {
        const c = await current();
        successfulCommand = randomUUID();
        const result = await service.command(
          scope,
          c.id,
          c.revision,
          successfulCommand,
          "play",
          "test-laptop",
          "spotify:track:" + trackId,
        );
        assert.equal(result.status, "accepted");
        assert(!("playing" in result));
        assert.equal(actions, 1);
        const call = calls.at(-1)!;
        assert.equal(call.path, "/v1/me/player/play");
        assert.equal(
          new URLSearchParams(call.query).get("device_id"),
          "test-laptop",
        );
        const reported = await service.read(
          scope,
          c.id,
          c.revision,
          "playback",
        );
        assert.equal((reported.data as any).playing, true);
        assert.equal(
          (reported.data as any).track.uri,
          "spotify:track:" + trackId,
        );
      },
    );
    await t.test(
      "the same command ID never executes twice and cannot be reused for another action",
      async () => {
        const c = await current(),
          before = actions;
        const replay = await service.command(
          scope,
          c.id,
          c.revision,
          successfulCommand,
          "play",
          "test-laptop",
          "spotify:track:" + trackId,
        );
        assert(replay.replay);
        assert.equal(actions, before);
        await rejects(
          () =>
            service.command(
              scope,
              c.id,
              c.revision,
              successfulCommand,
              "next",
              "test-laptop",
            ),
          "connection_changed",
        );
        assert.equal(actions, before);
      },
    );
    await t.test(
      "pause, resume, next, previous, queue and transfer have explicit provider commands",
      async () => {
        const c = await current();
        for (const action of [
          "pause",
          "resume",
          "next",
          "previous",
          "queue",
          "transfer",
        ] as const) {
          const result = await service.command(
            scope,
            c.id,
            c.revision,
            randomUUID(),
            action,
            "test-laptop",
            action === "queue" ? "spotify:track:" + trackId : undefined,
          );
          assert.equal(result.status, "accepted");
        }
        const transfer = calls.at(-1)!;
        assert.equal(transfer.path, "/v1/me/player");
        assert.deepEqual(JSON.parse(transfer.body), {
          device_ids: ["test-laptop"],
          play: false,
        });
      },
    );
    await t.test(
      "lost command response stays uncertain and replay does not resend",
      async () => {
        const c = await current(),
          id = randomUUID();
        mode = "lost_response";
        const before = actions;
        const result = await service.command(
          scope,
          c.id,
          c.revision,
          id,
          "next",
          "test-laptop",
        );
        assert.equal(result.status, "uncertain");
        assert.equal(actions, before + 1);
        mode = "normal";
        assert.equal(
          (
            await service.command(
              scope,
              c.id,
              c.revision,
              id,
              "next",
              "test-laptop",
            )
          ).status,
          "uncertain",
        );
        assert.equal(actions, before + 1);
      },
    );
    await t.test(
      "two concurrent submissions with one command identity reach the provider once",
      async () => {
        const c = await current(),
          id = randomUUID(),
          before = actions;
        const result = await Promise.all([
          service.command(scope, c.id, c.revision, id, "next", "test-laptop"),
          service.command(scope, c.id, c.revision, id, "next", "test-laptop"),
        ]);
        assert.equal(actions, before + 1);
        assert(result.some((r) => r.replay));
      },
    );
    await t.test(
      "expired token refresh preserves an omitted replacement refresh token",
      async () => {
        const c = await current(),
          secret = await row(),
          context = [
            "sway-direct-music-v1",
            actor,
            performerId,
            c.id,
            c.revision,
          ].join(":");
        const value = unseal<SpotifyTokens>(
          secret.sealedTokens,
          encryptionKey(env),
          context,
        );
        value.expiresAt = Date.now() - 1;
        await db
          .update(credentials)
          .set({ sealedTokens: seal(value, encryptionKey(env), context) })
          .where(eq(credentials.connectionId, c.id));
        const before = tokens;
        await service.read(scope, c.id, c.revision, "devices");
        assert.equal(tokens, before + 1);
        assert.equal(
          unseal<SpotifyTokens>(
            (await row()).sealedTokens,
            encryptionKey(env),
            context,
          ).refreshToken,
          "synthetic-refresh",
        );
        assert.equal((await current()).revision, c.revision);
      },
    );
    await t.test(
      "rate-limit cooldown is persisted and stops repeated provider requests",
      async () => {
        const c = await current();
        mode = "rate_limited";
        await rejects(
          () => service.read(scope, c.id, c.revision, "devices"),
          "rate_limited",
        );
        const before = calls.length;
        await rejects(
          () => service.read(scope, c.id, c.revision, "devices"),
          "rate_limited",
        );
        assert.equal(calls.length, before);
        mode = "normal";
        await db
          .update(credentials)
          .set({ cooldownUntil: null })
          .where(eq(credentials.connectionId, c.id));
      },
    );
    await t.test(
      "revoked authorization clears control eligibility until explicit reconnect",
      async () => {
        const c = await current();
        mode = "revoked";
        await rejects(
          () => service.read(scope, c.id, c.revision, "devices"),
          "reconnect_required",
        );
        assert.equal((await current()).status, "reconnect_required");
        mode = "normal";
        const before = calls.length;
        await rejects(
          () => service.read(scope, c.id, c.revision, "devices"),
          "reconnect_required",
        );
        assert.equal(calls.length, before);
        publicProfileId = "renamed-public-owner";
        await connect({ id: c.id, revision: c.revision });
        const [identity] = await db.select().from(connections).where(eq(connections.id, c.id));
        assert.equal(identity.externalAccountId, profileId);
        assert.notEqual(identity.externalAccountId, publicProfileId);
        const fresh = await current();
        assert.equal(fresh.id, c.id);
        assert.notEqual(fresh.revision, c.revision);
        assert.equal(fresh.selectedDeviceId, null);
        assert.equal(fresh.status, "connected");
        await rejects(
          () => service.read(scope, c.id, c.revision, "devices"),
          "connection_changed",
        );
      },
    );
    await t.test(
      "missing permissions preserve the previous connection instead of publishing a false success",
      async () => {
        const c = await current(),
          before = await row();
        mode = "missing_scope";
        await rejects(
          () => connect({ id: c.id, revision: c.revision }),
          "reconnect_required",
        );
        mode = "normal";
        assert.deepEqual(await row(), before);
      },
    );
    await t.test(
      "changed ownership during provider authorization cannot attach credentials to a new owner",
      async () => {
        const c = await current(),
          before = await row();
        onProfile = async () => {
          await db
            .update(performers)
            .set({ ownerUserId: other })
            .where(eq(performers.id, performerId));
        };
        try {
          await rejects(
            () => connect({ id: c.id, revision: c.revision }),
            "account_changed",
          );
        } finally {
          onProfile = null;
          await db
            .update(performers)
            .set({ ownerUserId: actor })
            .where(eq(performers.id, performerId));
        }
        assert.deepEqual(await row(), before);
      },
    );
    await t.test(
      "disconnect deletes credentials, provider identity and command history but preserves legacy music",
      async () => {
        const c = await current();
        const pending = await service.begin(scope, {
          id: c.id,
          revision: c.revision,
        });
        await service.disconnect(scope, c.id, c.revision);
        assert.equal((await db.select().from(credentials)).length, 0);
        assert.equal((await db.select().from(connections)).length, 0);
        assert.equal((await db.select().from(commands)).length, 0);
        assert.equal(
          (await db.select().from(performerLibrarySources)).length,
          1,
        );
        const before = tokens;
        await rejects(
          () =>
            service.finish(
              actor,
              new URL(pending.url).searchParams.get("state")!,
              pending.browser,
              "code",
            ),
          "oauth_expired",
        );
        assert.equal(tokens, before);
      },
    );

    await t.test(
      "real HTTP routes enforce access, same-origin writes and one-use browser-bound callbacks",
      async () => {
        const app = express();
        app.use(express.json());
        app.use(
          "/api/talent/direct-music",
          createDirectMusicRouter({
            db,
            env,
            provider,
            authorize: async (req) => {
              const id = req.headers["x-test-actor"];
              return typeof id === "string" && [actor, other].some(allowed => allowed === id)
                ? { allowed: true, actor: { actorId: id } }
                : {
                    allowed: false,
                    status: 401,
                    reason: "Test sign-in required.",
                  };
            },
          }),
        );
        server = app.listen(0, "127.0.0.1");
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const address = server.address();
        assert(address && typeof address !== "string");
        const base = "http://127.0.0.1:" + address.port;
        env.SWAY_APP_BASE_URL = base;
        const request = (
          path: string,
          body?: unknown,
          extra: Record<string, string> = {},
        ) =>
          fetch(base + "/api/talent/direct-music" + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              "x-test-actor": actor,
              ...(body === undefined
                ? {}
                : { Origin: base, "Content-Type": "application/json" }),
              ...extra,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "manual",
          });
        const denied = await fetch(
          base + "/api/talent/direct-music?performerId=" + performerId,
        );
        assert.equal(denied.status, 401);
        assert.match(denied.headers.get("cache-control")!, /no-store/);
        assert.equal(
          (
            await request("?performerId=" + performerId, undefined, {
              "x-test-actor": other,
            })
          ).status,
          403,
        );
        const body = { performerId, expectedConnection: null };
        assert.equal(
          (
            await request("/spotify/connect", body, {
              Origin: "https://evil.example",
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/spotify/connect", { performerId })).status,
          422,
        );
        const begin = await request("/spotify/connect", body);
        assert.equal(begin.status, 200);
        const data = await begin.json(),
          cookie = begin.headers.get("set-cookie")!.split(";")[0];
        assert.match(begin.headers.get("set-cookie")!, /HttpOnly/i);
        const state = new URL(data.authorizationUrl).searchParams.get("state")!;
        const forged = await request(
          "/spotify/callback?state=" + state + "&code=test-code",
        );
        assert.equal(forged.status, 303);
        assert.match(forged.headers.get("location")!, /oauth_expired/);
        const callback = await request(
          "/spotify/callback?state=" + state + "&code=test-code",
          undefined,
          { Cookie: cookie },
        );
        assert.equal(callback.status, 303);
        assert.equal(
          callback.headers.get("location"),
          "/talent/connections?direct_music=connected",
        );
        const again = await request(
          "/spotify/callback?state=" + state + "&code=test-code",
          undefined,
          { Cookie: cookie },
        );
        assert.match(again.headers.get("location")!, /oauth_expired/);
        const c = await current();
        assert.equal(
          (
            await request(
              "/" +
                c.id +
                "/read?" +
                new URLSearchParams({
                  performerId,
                  revision: c.revision,
                  kind: "anything",
                }),
            )
          ).status,
          422,
        );
        const browse = await request(
          "/" +
            c.id +
            "/read?" +
            new URLSearchParams({
              performerId,
              revision: c.revision,
              kind: "playlists",
            }),
        );
        assert.equal(browse.status, 200);
        assert.equal((await browse.json()).data.items[0].name, label);
        const cancel = await request("/spotify/connect", {
          performerId,
          expectedConnection: { id: c.id, revision: c.revision },
        });
        const cancelData = await cancel.json(),
          cancelCookie = cancel.headers.get("set-cookie")!.split(";")[0],
          cancelState = new URL(cancelData.authorizationUrl).searchParams.get(
            "state",
          )!;
        const canceled = await request(
          "/spotify/callback?state=" + cancelState + "&error=access_denied",
          undefined,
          { Cookie: cancelCookie },
        );
        assert.match(canceled.headers.get("location")!, /oauth_canceled/);
        assert.equal((await current()).revision, c.revision);
        const disconnect = await request("/" + c.id + "/disconnect", {
          performerId,
          revision: c.revision,
        });
        assert.equal(disconnect.status, 200);
        assert.equal((await disconnect.json()).disconnected, true);
      },
    );
    await t.test(
      "expired and superseded authorization attempts cannot call the token endpoint",
      async () => {
        let a = await service.begin(scope, null);
        let state = new URL(a.url).searchParams.get("state")!;
        await db
          .update(attempts)
          .set({ expiresAt: new Date(Date.now() - 1) })
          .where(eq(attempts.stateHash, digest(state)));
        const before = tokens;
        await rejects(
          () => service.finish(actor, state, a.browser, "code"),
          "oauth_expired",
        );
        a = await service.begin(scope, null);
        state = new URL(a.url).searchParams.get("state")!;
        await service.begin(scope, null);
        await rejects(
          () => service.finish(actor, state, a.browser, "code"),
          "oauth_expired",
        );
        assert.equal(tokens, before);
      },
    );
    await t.test(
      "disconnect still works when operator approval is withdrawn or the encryption key is unavailable",
      async () => {
        await connect();
        const c = await current();
        await new DirectMusicService(
          db,
          {
            ...env,
            SWAY_MUSIC_TOKEN_KEY: "",
            SWAY_SPOTIFY_DIRECT_USE_APPROVED: "",
          },
          provider,
        ).disconnect(scope, c.id, c.revision);
        assert.equal((await service.overview(scope)).connections.length, 0);
      },
    );
  });
  console.log(
    "DIRECT_MUSIC_INTEGRATION_COMPLETE " +
      JSON.stringify({
        database: proof.kind,
        provider: "synthetic",
        realProviderCalls: 0,
        productionWrites: false,
        providerRequests: calls.length,
        commands: actions,
        tokenExchanges: tokens,
      }),
  );
} finally {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await proof.close();
}
