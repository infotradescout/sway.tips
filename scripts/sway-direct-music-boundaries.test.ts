import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  SpotifyDirectProvider,
  SPOTIFY_SCOPES,
} from "../src/server/direct-music/spotify";
import { DirectMusicClient } from "../src/direct-music-client";
import {
  seal,
  unseal,
  encryptionKey,
  MusicFailure,
} from "../src/server/direct-music/security";
const trackId = "4uLU6hMCjMI75M1A2tKUQC",
  playlistId = "37i9dQZF1DXcBWIGoYBM5M",
  actor = randomUUID();
const row = {
  id: trackId,
  name: "Test track",
  type: "track",
  artists: [{ name: "Test artist" }],
  album: { images: [] },
};
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const credentials = {
  access_token: "access",
  refresh_token: "refresh",
  token_type: "Bearer",
  expires_in: 3600,
  scope: SPOTIFY_SCOPES.join(" "),
};
const connection = {
  id: randomUUID(),
  revision: randomUUID(),
  provider: "spotify" as const,
  label: "Test listener",
  status: "connected" as const,
  selectedDeviceId: "device",
  connectedAt: new Date().toISOString(),
};
const track = {
  id: trackId,
  uri: "spotify:track:" + trackId,
  title: "Test track",
  artist: "Test artist",
  artwork: null,
  url: "https://open.spotify.com/track/" + trackId,
  playable: true,
};
const fetcher = (response: () => Response | Promise<Response>) =>
  (async () => response()) as typeof fetch;
const rejectCode = (work: () => Promise<unknown>, code: string) =>
  assert.rejects(work, (error: any) => error.code === code);

test("Direct music provider boundary rejects ambiguous or unsafe responses", async (t) => {
  await t.test("immutable account identity survives public ID changes and omission", async () => {
    let response: Record<string, unknown> = {
      id: "mutable-public-id", account_id: "stable-account-id", display_name: "Listener",
    };
    const p = new SpotifyDirectProvider(fetcher(() => json(response)));
    assert.deepEqual(await p.profile("token"), { id: "stable-account-id", label: "Listener" });
    response.id = "renamed-public-id";
    assert.equal((await p.profile("token")).id, "stable-account-id");
    delete response.id;
    response.display_name = null;
    assert.deepEqual(await p.profile("token"), { id: "stable-account-id", label: "stable-account-id" });
    response = { id: "mutable-public-id", account_id: "other-account-id" };
    assert.equal((await p.profile("token")).id, "other-account-id");
  });
  await t.test("missing or malformed immutable identity never falls back to public ID", async () => {
    for (const account_id of [undefined, null, "", "   ", 42, {}, "x".repeat(257)]) {
      const p = new SpotifyDirectProvider(fetcher(() => json({
        id: "valid-but-mutable-public-id", account_id, display_name: "Listener",
      })));
      await rejectCode(() => p.profile("token"), "invalid_provider_response");
    }
  });
  await t.test(
    "token shape, expiry, refresh identity and granted scopes are verified",
    async () => {
      for (const change of [
        { access_token: "" },
        { expires_in: 0 },
        { expires_in: NaN },
        { expires_in: 90000 },
        { token_type: "Other" },
        { refresh_token: "" },
        { scope: "user-read-private" },
      ]) {
        const p = new SpotifyDirectProvider(
          fetcher(() => json({ ...credentials, ...change })),
        );
        await assert.rejects(() =>
          p.tokens("a".repeat(32), { grant_type: "authorization_code" }),
        );
      }
    },
  );
  await t.test(
    "a redirect is refused and never followed with authorization",
    async () => {
      let calls = 0;
      const p = new SpotifyDirectProvider((async (_url, init) => {
        calls++;
        assert.equal(init.redirect, "error");
        return new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example" },
        });
      }) as typeof fetch);
      await assert.rejects(() => p.devices("token"));
      assert.equal(calls, 1);
    },
  );
  await t.test(
    "provider status and retry delay remain distinct, without leaking its error body",
    async () => {
      for (const [status, code] of [
        [401, "reconnect_required"],
        [403, "provider_access_denied"],
        [404, "provider_unavailable"],
        [429, "rate_limited"],
        [503, "provider_unavailable"],
      ] as const) {
        const p = new SpotifyDirectProvider(
          fetcher(() =>
            json({ secret: "do-not-leak" }, status, { "Retry-After": "7" }),
          ),
        );
        await assert.rejects(
          () => p.devices("token"),
          (error: any) =>
            error.code === code &&
            !error.message.includes("do-not-leak") &&
            (status !== 429 || error.retryAfter === 7),
        );
      }
    },
  );
  await t.test(
    "a valid no-active-player response is distinct from malformed playback",
    async () => {
      const p = new SpotifyDirectProvider(
        fetcher(() => new Response(null, { status: 204 })),
      );
      const state = await p.playback("token");
      assert.equal(state.deviceId, null);
      assert.equal(state.playing, false);
      for (const data of [
        {},
        [],
        { is_playing: true },
        { is_playing: true, device: {}, item: {} },
      ])
        await assert.rejects(() =>
          new SpotifyDirectProvider(fetcher(() => json(data))).playback(
            "token",
          ),
        );
    },
  );
  await t.test(
    "oversized or unreadable provider JSON cannot become a success",
    async () => {
      for (const response of [
        () => new Response("bad json"),
        () => json({}, 200, { "Content-Length": "2000001" }),
        () => json({ x: "x".repeat(2000001) }),
      ])
        await assert.rejects(() =>
          new SpotifyDirectProvider(fetcher(response)).devices("token"),
        );
    },
  );
  await t.test(
    "unsafe, looping or truncated library paging is rejected rather than fetched",
    async () => {
      for (const next of [
        "https://evil.example/page",
        "https://api.spotify.com/v1/me?offset=1",
        "https://user:pass@api.spotify.com/v1/me/playlists?offset=1",
        "https://api.spotify.com/v1/me/playlists?offset=0",
        "https://api.spotify.com/v1/me/playlists?offset=1#part",
        null,
      ]) {
        let calls = 0;
        const p = new SpotifyDirectProvider(
          fetcher(() => {
            calls++;
            return json({
              items: [{ id: playlistId, name: "Test" }],
              offset: 0,
              total: 2,
              next,
            });
          }),
        );
        await assert.rejects(() => p.browse("token", "playlists", 0));
        assert.equal(calls, 1);
      }
    },
  );
  await t.test(
    "provider next URL yields only a validated offset, never a fetchable arbitrary URL",
    async () => {
      const p = new SpotifyDirectProvider(
        fetcher(() =>
          json({
            items: [{ id: playlistId, name: "Test" }],
            offset: 0,
            total: 2,
            next: "https://api.spotify.com/v1/me/playlists?offset=1&limit=50",
          }),
        ),
      );
      const result = await p.browse("token", "playlists", 0);
      assert.equal(result.nextOffset, 1);
      assert(!("next" in result));
    },
  );
  await t.test(
    "migrated item envelopes, unavailable tracks, local songs and episodes are handled distinctly",
    async () => {
      const p = new SpotifyDirectProvider(
        fetcher(() =>
          json({
            items: [
              { item: null },
              { item: { is_local: true } },
              { item: { type: "episode" } },
              { item: { ...row, is_playable: false } },
            ],
            offset: 0,
            total: 4,
            next: null,
          }),
        ),
      );
      const result = await p.browse("token", "playlist", 0, "", playlistId);
      assert.equal(result.items.length, 1);
      assert.equal((result.items[0] as any).playable, false);
    },
  );
  await t.test(
    "invalid commands and playlist paths cause zero provider calls",
    async () => {
      let calls = 0;
      const p = new SpotifyDirectProvider(
        fetcher(() => {
          calls++;
          return json({});
        }),
      );
      await assert.rejects(() =>
        p.browse("token", "playlist", 0, "", "../../me"),
      );
      await assert.rejects(() =>
        p.command("token", "play", "device", "https://evil.example/audio"),
      );
      await assert.rejects(() => p.command("token", "next", ""));
      assert.equal(calls, 0);
    },
  );
  await t.test(
    "whole request and body deadlines work even when transport ignores abort",
    async () => {
      const original = AbortSignal.timeout;
      AbortSignal.timeout = () => original(10);
      const keepAlive = setInterval(() => {}, 100);
      try {
        const hanging = new SpotifyDirectProvider(
          fetcher(() => new Promise<Response>(() => {})),
        );
        await rejectCode(() => hanging.devices("token"), "provider_timeout");
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
        });
        const body = new SpotifyDirectProvider(
          fetcher(() => new Response(stream)),
        );
        await rejectCode(() => body.devices("token"), "provider_timeout");
      } finally {
        clearInterval(keepAlive);
        AbortSignal.timeout = original;
      }
    },
  );
  await t.test(
    "encrypted credentials cannot be copied to another connection or altered",
    async () => {
      const key = encryptionKey({
        SWAY_MUSIC_TOKEN_KEY: Buffer.alloc(32, 8).toString("base64"),
      });
      const data = seal(
        { refreshToken: "refresh" },
        key,
        "owner-one:connection-one",
      );
      assert.equal(
        unseal<any>(data, key, "owner-one:connection-one").refreshToken,
        "refresh",
      );
      assert.throws(() => unseal(data, key, "owner-two:connection-one"));
      assert.throws(() =>
        unseal(data.replace(/.$/, "!"), key, "owner-one:connection-one"),
      );
    },
  );
});

test("Direct music browser client validates identity and never replays unknown commands", async (t) => {
  const body = (data: unknown, overrides = {}) => ({
    performerId: actor,
    connectionId: connection.id,
    revision: connection.revision,
    data,
    ...overrides,
  });
  await t.test(
    "foreign owner, connection generation and malformed tracks are refused",
    async () => {
      for (const override of [
        { performerId: randomUUID() },
        { connectionId: randomUUID() },
        { revision: randomUUID() },
      ]) {
        const c = new DirectMusicClient(
          actor,
          new AbortController().signal,
          fetcher(() =>
            json(
              body(
                { items: [track], offset: 0, nextOffset: null, total: 1 },
                override,
              ),
            ),
          ),
        );
        await assert.rejects(() => c.browse(connection, "saved"));
      }
      const c = new DirectMusicClient(
        actor,
        new AbortController().signal,
        fetcher(() =>
          json(
            body({
              items: [{ ...track, uri: "spotify:track:wrong" }],
              offset: 0,
              nextOffset: null,
              total: 1,
            }),
          ),
        ),
      );
      await assert.rejects(() => c.browse(connection, "saved"));
    },
  );
  await t.test(
    "stale playback observations cannot enable controls",
    async () => {
      const c = new DirectMusicClient(
        actor,
        new AbortController().signal,
        fetcher(() =>
          json(
            body({
              observedAt: new Date(Date.now() - 60000).toISOString(),
              deviceId: "device",
              playing: true,
              progressMs: 0,
              track,
              disallowed: [],
            }),
          ),
        ),
      );
      await assert.rejects(() => c.playback(connection));
    },
  );
  await t.test(
    "a definite provider rejection retains its receipt rather than becoming uncertain",
    async () => {
      const id = randomUUID();
      let calls = 0;
      const c = new DirectMusicClient(
        actor,
        new AbortController().signal,
        fetcher(() => {
          calls++;
          return json(
            {
              id,
              status: "rejected",
              code: "provider_access_denied",
              message: "Provider denied the action.",
              replay: false,
            },
            409,
          );
        }),
      );
      assert.equal(
        (await c.command(connection, id, "next", "device")).status,
        "rejected",
      );
      assert.equal(calls, 1);
    },
  );
  await t.test(
    "transport failure triggers exactly one command request, not an automatic retry",
    async () => {
      let calls = 0;
      const c = new DirectMusicClient(
        actor,
        new AbortController().signal,
        fetcher(() => {
          calls++;
          throw new Error("Response lost");
        }),
      );
      await assert.rejects(() =>
        c.command(connection, randomUUID(), "queue", "device", track.uri),
      );
      assert.equal(calls, 1);
    },
  );
  await t.test(
    "account-lifetime cancellation rejects late data even if the fetcher completes",
    async () => {
      const controller = new AbortController();
      let finish!: (value: Response) => void;
      const c = new DirectMusicClient(
        actor,
        controller.signal,
        fetcher(() => new Promise((resolve) => (finish = resolve))),
      );
      const read = c.overview();
      controller.abort();
      finish(
        json({
          performerId: actor,
          provider: "spotify",
          availability: "available",
          connections: [connection],
        }),
      );
      await assert.rejects(read);
    },
  );
  await t.test(
    "pre-aborted account lifetimes do not make any request",
    async () => {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      const c = new DirectMusicClient(
        actor,
        controller.signal,
        fetcher(() => {
          calls++;
          return json({});
        }),
      );
      await assert.rejects(() => c.overview());
      assert.equal(calls, 0);
    },
  );
  await t.test(
    "a stalled response body has a bounded client lifetime",
    async () => {
      const original = AbortSignal.timeout;
      AbortSignal.timeout = () => original(10);
      const keepAlive = setInterval(() => {}, 100);
      try {
        const c = new DirectMusicClient(
          actor,
          new AbortController().signal,
          fetcher(() => new Response(new ReadableStream({ start() {} }))),
        );
        await assert.rejects(() => c.overview());
      } finally {
        clearInterval(keepAlive);
        AbortSignal.timeout = original;
      }
    },
  );
});

test("Direct music migration preserves unrelated schema and supplies the current generated snapshot", () => {
  const previous = JSON.parse(
    readFileSync("drizzle/meta/0051_snapshot.json", "utf8"),
  );
  const current = JSON.parse(
    readFileSync("drizzle/meta/0052_snapshot.json", "utf8"),
  );
  assert.equal(current.prevId, previous.id);
  for (const name of Object.keys(previous.tables))
    assert.deepEqual(current.tables[name], previous.tables[name]);
  assert.deepEqual(
    Object.keys(current.tables)
      .filter((name) => !previous.tables[name])
      .sort(),
    [
      "public.direct_music_commands",
      "public.direct_music_credentials",
      "public.direct_music_oauth_attempts",
    ],
  );
  const sql = readFileSync(
    "drizzle/0052_direct_music_authorization.sql",
    "utf8",
  );
  assert(!/DROP|TRUNCATE|DELETE FROM/.test(sql));
  assert(
    !/ALTER TABLE "(?:sway_program_memberships|affiliate_commission_events)"/.test(
      sql,
    ),
  );
});
