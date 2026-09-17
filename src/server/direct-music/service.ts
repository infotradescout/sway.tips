import { randomUUID, createHash } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { SwayDb } from "../../db/client";
import {
  directMusicCredentials as credentials,
  directMusicOAuthAttempts as attempts,
  directMusicCommands as commands,
  performerMusicSourceConnections as connections,
  performers,
} from "../../db/schema";
import type {
  MusicCommandAction,
  MusicCommandReceipt,
  MusicConnection,
} from "../../direct-music";
import {
  SpotifyDirectProvider,
  SPOTIFY_SCOPES,
  type SpotifyTokens,
} from "./spotify";
import {
  appOrigin,
  availability,
  digest,
  encryptionKey,
  equalSecret,
  MusicFailure,
  randomSecret,
  requireAvailable,
  requireUuid,
  seal,
  unseal,
} from "./security";
export type MusicScope = { actorId: string; performerId: string };
type Tx = Parameters<Parameters<SwayDb["transaction"]>[0]>[0];
type Expected = { id: string; revision: string } | null;
type Active = {
  connection: typeof connections.$inferSelect;
  secret: typeof credentials.$inferSelect;
};
const changed = () =>
  new MusicFailure(
    409,
    "connection_changed",
    "The music account or selected player changed. Refresh before continuing.",
  );
const tokenContext = (s: MusicScope, id: string, revision: string) =>
  ["sway-direct-music-v1", s.actorId, s.performerId, id, revision].join(":");
const oauthContext = (s: MusicScope, stateHash: string) =>
  ["sway-direct-oauth-v1", s.actorId, s.performerId, stateHash].join(":");
const publicConnection = (row: Active): MusicConnection => ({
  id: row.connection.id,
  provider: "spotify",
  label: row.connection.externalAccountLabel ?? "Spotify",
  revision: row.secret.revision,
  selectedDeviceId: row.secret.selectedDeviceId,
  status:
    row.connection.authStatus === "connected"
      ? "connected"
      : "reconnect_required",
  connectedAt: row.connection.connectedAt?.toISOString() ?? null,
});
function asFailure(error: unknown): MusicFailure {
  return error instanceof MusicFailure
    ? error
    : new MusicFailure(
        503,
        "connection_unavailable",
        "The music connection could not be confirmed. Refresh before repeating an action.",
      );
}
export class DirectMusicService {
  constructor(
    private readonly db: SwayDb,
    private readonly env: NodeJS.ProcessEnv,
    private readonly provider = new SpotifyDirectProvider(),
  ) {}
  private async owner(tx: Tx, scope: MusicScope) {
    await tx.execute(sql.raw("set local lock_timeout = '3s'"));
    const [row] = await tx
      .select({ owner: performers.ownerUserId })
      .from(performers)
      .where(eq(performers.id, scope.performerId))
      .limit(1)
      .for("update");
    if (!row || row.owner !== scope.actorId)
      throw new MusicFailure(
        403,
        "account_changed",
        "This performer account is no longer available to this session.",
      );
  }
  private async active(
    tx: Tx,
    scope: MusicScope,
    id?: string,
  ): Promise<Active | undefined> {
    const rows = await tx
      .select({ connection: connections, secret: credentials })
      .from(credentials)
      .innerJoin(connections, eq(connections.id, credentials.connectionId))
      .where(
        and(
          eq(credentials.performerId, scope.performerId),
          eq(credentials.actorUserId, scope.actorId),
          eq(connections.performerId, scope.performerId),
          eq(connections.providerKey, "spotify"),
          eq(connections.sourceMode, "oauth_remote"),
          ...(id ? [eq(credentials.connectionId, id)] : []),
        ),
      )
      .limit(2)
      .for("update", { of: credentials });
    if (rows.length > 1) throw changed();
    return rows[0];
  }
  async overview(scope: MusicScope) {
    const values = await this.db.transaction(async (tx) => {
      await this.owner(tx, scope);
      const row = await this.active(tx, scope);
      return row ? [publicConnection(row)] : [];
    });
    return {
      performerId: scope.performerId,
      provider: "spotify" as const,
      availability: availability(this.env),
      connections: values,
    };
  }
  async begin(scope: MusicScope, expected: Expected) {
    requireAvailable(this.env);
    const state = randomSecret(),
      browser = randomSecret(),
      verifier = randomSecret(),
      stateHash = digest(state),
      key = encryptionKey(this.env);
    const expiresAt = new Date(Date.now() + 600000);
    await this.db.transaction(async (tx) => {
      await this.owner(tx, scope);
      const row = await this.active(tx, scope);
      if (
        (expected === null && row) ||
        (expected &&
          (!row ||
            row.connection.id !== expected.id ||
            row.secret.revision !== expected.revision))
      )
        throw changed();
      await tx.delete(attempts).where(lt(attempts.expiresAt, new Date()));
      await tx
        .delete(attempts)
        .where(
          and(
            eq(attempts.performerId, scope.performerId),
            eq(attempts.actorUserId, scope.actorId),
          ),
        );
      await tx
        .insert(attempts)
        .values({
          stateHash,
          actorUserId: scope.actorId,
          performerId: scope.performerId,
          browserHash: digest(browser),
          sealedVerifier: seal(
            { verifier },
            key,
            oauthContext(scope, stateHash),
          ),
          expectedConnectionId: expected?.id ?? null,
          expectedRevision: expected?.revision ?? null,
          expiresAt,
        });
    });
    const url = new URL("https://accounts.spotify.com/authorize");
    url.search = new URLSearchParams({
      client_id: this.env.SWAY_SPOTIFY_CLIENT_ID!,
      response_type: "code",
      redirect_uri:
        appOrigin(this.env) + "/api/talent/direct-music/spotify/callback",
      scope: SPOTIFY_SCOPES.join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      show_dialog: "true",
    }).toString();
    return { url: url.href, browser, expiresAt };
  }
  async finish(
    actorId: string,
    state: string,
    browser: string,
    code: string | null,
  ) {
    requireAvailable(this.env);
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(browser)
    )
      throw new MusicFailure(
        409,
        "oauth_expired",
        "This connection attempt expired. Start again from Sources.",
      );
    const stateHash = digest(state),
      key = encryptionKey(this.env);
    const attempt = await this.db.transaction(async (tx) => {
      const [found] = await tx
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.stateHash, stateHash),
            eq(attempts.actorUserId, actorId),
          ),
        )
        .limit(1);
      if (
        !found ||
        found.claimedAt ||
        found.expiresAt.getTime() <= Date.now() ||
        !equalSecret(found.browserHash, digest(browser))
      )
        throw new MusicFailure(
          409,
          "oauth_expired",
          "This connection attempt expired. Start again from Sources.",
        );
      await this.owner(tx, { actorId, performerId: found.performerId });
      const [claimed] = await tx
        .update(attempts)
        .set({ claimedAt: new Date() })
        .where(
          and(
            eq(attempts.stateHash, stateHash),
            isNull(attempts.claimedAt),
            gt(attempts.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!claimed) throw changed();
      return claimed;
    });
    const scope = { actorId, performerId: attempt.performerId };
    try {
      if (!code)
        throw new MusicFailure(
          409,
          "oauth_canceled",
          "Music account connection was canceled.",
        );
      const { verifier } = unseal<{ verifier: string }>(
        attempt.sealedVerifier,
        key,
        oauthContext(scope, stateHash),
      );
      const tokens = await this.provider.tokens(
        this.env.SWAY_SPOTIFY_CLIENT_ID!,
        {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          redirect_uri:
            appOrigin(this.env) + "/api/talent/direct-music/spotify/callback",
        },
      );
      const profile = await this.provider.profile(tokens.accessToken);
      const result = await this.db.transaction(async (tx) => {
        await this.owner(tx, scope);
        const [still] = await tx
          .select()
          .from(attempts)
          .where(
            and(
              eq(attempts.stateHash, stateHash),
              gt(attempts.expiresAt, new Date()),
            ),
          )
          .limit(1)
          .for("update");
        if (!still || !still.claimedAt) throw changed();
        const existing = await this.active(tx, scope);
        if (
          (!attempt.expectedConnectionId && existing) ||
          (attempt.expectedConnectionId &&
            (!existing ||
              existing.connection.id !== attempt.expectedConnectionId ||
              existing.secret.revision !== attempt.expectedRevision))
        )
          throw changed();
        const id = existing?.connection.id ?? randomUUID(),
          revision = randomUUID(),
          now = new Date();
        const values = {
          performerId: scope.performerId,
          providerKey: "spotify",
          providerDisplayName: "Spotify",
          sourceMode: "oauth_remote",
          connectionStatus: "connected",
          authStatus: "connected",
          capabilitySnapshot: {
            browse: true,
            devices: true,
            controlExternalPlayback: true,
            playInSway: false,
          },
          externalAccountId: profile.id,
          externalAccountLabel: profile.label,
          tokenVaultRef: id,
          connectedAt: now,
          disconnectedAt: null,
          updatedAt: now,
        };
        if (existing)
          await tx
            .update(connections)
            .set(values)
            .where(eq(connections.id, id));
        else await tx.insert(connections).values({ id, ...values });
        await tx
          .insert(credentials)
          .values({
            connectionId: id,
            actorUserId: actorId,
            performerId: scope.performerId,
            revision,
            sealedTokens: seal(tokens, key, tokenContext(scope, id, revision)),
          })
          .onConflictDoUpdate({
            target: credentials.connectionId,
            set: {
              revision,
              sealedTokens: seal(
                tokens,
                key,
                tokenContext(scope, id, revision),
              ),
              selectedDeviceId: null,
              cooldownUntil: null,
              commandLeaseId: null,
              commandLeaseUntil: null,
              updatedAt: now,
            },
          });
        await tx.delete(attempts).where(eq(attempts.stateHash, stateHash));
        return { id, revision, performerId: scope.performerId };
      });
      return result;
    } catch (error) {
      await this.db.delete(attempts).where(eq(attempts.stateHash, stateHash));
      throw asFailure(error);
    }
  }
  private async use<T>(
    scope: MusicScope,
    id: string,
    revision: string,
    work: (tx: Tx, row: Active, tokens: SpotifyTokens) => Promise<T>,
  ): Promise<T> {
    requireAvailable(this.env);
    requireUuid(id);
    requireUuid(revision);
    const result = await this.db.transaction(async (tx) => {
      await this.owner(tx, scope);
      const row = await this.active(tx, scope, id);
      if (!row || row.secret.revision !== revision) throw changed();
      if (row.connection.authStatus !== "connected")
        throw new MusicFailure(
          409,
          "reconnect_required",
          "Reconnect this music account before continuing.",
        );
      const wait = row.secret.cooldownUntil
        ? row.secret.cooldownUntil.getTime() - Date.now()
        : 0;
      if (wait > 0)
        throw new MusicFailure(
          429,
          "rate_limited",
          "Spotify is busy. Wait before trying again.",
          Math.ceil(wait / 1000),
        );
      try {
        let tokens = unseal<SpotifyTokens>(
          row.secret.sealedTokens,
          encryptionKey(this.env),
          tokenContext(scope, id, revision),
        );
        if (
          !tokens.accessToken ||
          !tokens.refreshToken ||
          !Number.isFinite(tokens.expiresAt) ||
          !Array.isArray(tokens.scopes)
        )
          throw new MusicFailure(
            409,
            "reconnect_required",
            "Reconnect this music account before continuing.",
          );
        if (tokens.expiresAt <= Date.now() + 30000) {
          tokens = await this.provider.tokens(
            this.env.SWAY_SPOTIFY_CLIENT_ID!,
            { grant_type: "refresh_token", refresh_token: tokens.refreshToken },
            tokens,
          );
          await tx
            .update(credentials)
            .set({
              sealedTokens: seal(
                tokens,
                encryptionKey(this.env),
                tokenContext(scope, id, revision),
              ),
              updatedAt: new Date(),
            })
            .where(eq(credentials.connectionId, id));
        }
        return { value: await work(tx, row, tokens) };
      } catch (error) {
        const problem = asFailure(error);
        if (problem.code === "reconnect_required")
          await tx
            .update(connections)
            .set({ authStatus: "reconnect_required", updatedAt: new Date() })
            .where(eq(connections.id, id));
        if (problem.retryAfter)
          await tx
            .update(credentials)
            .set({
              cooldownUntil: new Date(Date.now() + problem.retryAfter * 1000),
            })
            .where(eq(credentials.connectionId, id));
        return { error: problem };
      }
    });
    if ("error" in result) throw result.error;
    return result.value;
  }
  async read(
    scope: MusicScope,
    id: string,
    revision: string,
    kind:
      | "devices"
      | "playback"
      | "playlists"
      | "playlist"
      | "saved"
      | "search",
    offset = 0,
    query = "",
    playlistId = "",
  ) {
    return this.use(scope, id, revision, async (_tx, _row, tokens) => {
      const data =
        kind === "devices"
          ? await this.provider.devices(tokens.accessToken)
          : kind === "playback"
            ? await this.provider.playback(tokens.accessToken)
            : await this.provider.browse(
                tokens.accessToken,
                kind,
                offset,
                query,
                playlistId,
              );
      return {
        performerId: scope.performerId,
        connectionId: id,
        revision,
        data,
      };
    });
  }
  async target(
    scope: MusicScope,
    id: string,
    revision: string,
    deviceId: string,
  ) {
    return this.use(scope, id, revision, async (tx, row, tokens) => {
      if (
        row.secret.commandLeaseUntil &&
        row.secret.commandLeaseUntil.getTime() > Date.now()
      )
        throw new MusicFailure(
          409,
          "command_in_flight",
          "Wait for the pending command before changing players.",
        );
      const devices = await this.provider.devices(tokens.accessToken);
      const device = devices.find((d) => d.id === deviceId && !d.restricted);
      if (!device)
        throw new MusicFailure(
          409,
          "device_unavailable",
          "This player is unavailable or restricted. Refresh players and choose again.",
        );
      await tx
        .update(credentials)
        .set({ selectedDeviceId: deviceId, updatedAt: new Date() })
        .where(eq(credentials.connectionId, id));
      return {
        performerId: scope.performerId,
        connectionId: id,
        revision,
        deviceId,
      };
    });
  }
  async disconnect(scope: MusicScope, id: string, revision: string) {
    // Disconnect remains possible if operator approval/configuration is removed or the encryption key rotates.
    return this.db.transaction(async (tx) => {
      await this.owner(tx, scope);
      const row = await this.active(tx, scope, id);
      if (!row || row.secret.revision !== revision) throw changed();
      await tx
        .delete(attempts)
        .where(
          and(
            eq(attempts.actorUserId, scope.actorId),
            eq(attempts.performerId, scope.performerId),
          ),
        );
      await tx.delete(connections).where(eq(connections.id, id));
      return {
        disconnected: true,
        performerId: scope.performerId,
        connectionId: id,
      };
    });
  }
  async command(
    scope: MusicScope,
    id: string,
    revision: string,
    commandId: string,
    action: MusicCommandAction,
    deviceId: string,
    uri?: string,
  ): Promise<MusicCommandReceipt> {
    requireAvailable(this.env);
    requireUuid(id);
    requireUuid(revision);
    requireUuid(commandId);
    if (
      ![
        "play",
        "resume",
        "pause",
        "next",
        "previous",
        "queue",
        "transfer",
      ].includes(action) ||
      !deviceId ||
      deviceId.length > 512 ||
      (["play", "queue"].includes(action) &&
        !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri ?? ""))
    )
      throw new MusicFailure(
        422,
        "invalid_request",
        "Choose a supported action, player and track.",
      );
    const requestHash = digest(
      JSON.stringify([
        scope.actorId,
        scope.performerId,
        id,
        revision,
        action,
        deviceId,
        uri ?? null,
      ]),
    );
    const receipt = (
      row: typeof commands.$inferSelect,
      replay: boolean,
    ): MusicCommandReceipt => ({
      id: row.id,
      status: row.status as MusicCommandReceipt["status"],
      code: row.code,
      message: row.message,
      replay,
    });
    const previous = await this.db.transaction(async (tx) => {
      await this.owner(tx, scope);
      const row = await this.active(tx, scope, id);
      if (
        !row ||
        row.secret.revision !== revision ||
        row.secret.selectedDeviceId !== deviceId
      )
        throw changed();
      const [found] = await tx
        .select()
        .from(commands)
        .where(eq(commands.id, commandId))
        .limit(1);
      if (found) {
        if (
          found.requestHash !== requestHash ||
          found.actorUserId !== scope.actorId
        )
          throw changed();
        if (
          found.status === "in_flight" &&
          found.expiresAt.getTime() < Date.now()
        ) {
          const [updated] = await tx
            .update(commands)
            .set({
              status: "uncertain",
              code: "outcome_unknown",
              message:
                "The earlier command outcome is unknown. Check the player before sending a new action.",
            })
            .where(eq(commands.id, commandId))
            .returning();
          return receipt(updated, true);
        }
        return receipt(found, true);
      }
      if (
        row.secret.commandLeaseUntil &&
        row.secret.commandLeaseUntil.getTime() > Date.now()
      )
        throw new MusicFailure(
          409,
          "command_in_flight",
          "A playback command is already in progress.",
        );
      await tx
        .delete(commands)
        .where(
          and(
            eq(commands.connectionId, id),
            lt(commands.expiresAt, new Date(Date.now() - 86400000)),
          ),
        );
      const expiresAt = new Date(Date.now() + 45000);
      await tx
        .insert(commands)
        .values({
          id: commandId,
          connectionId: id,
          actorUserId: scope.actorId,
          performerId: scope.performerId,
          requestHash,
          status: "in_flight",
          message:
            "Waiting for the provider response. Playback is not yet confirmed.",
          expiresAt,
        });
      await tx
        .update(credentials)
        .set({ commandLeaseId: commandId, commandLeaseUntil: expiresAt })
        .where(eq(credentials.connectionId, id));
      return null;
    });
    if (previous) return previous;
    try {
      return await this.use(scope, id, revision, async (tx, row, tokens) => {
        if (
          row.secret.commandLeaseId !== commandId ||
          !row.secret.commandLeaseUntil ||
          row.secret.commandLeaseUntil.getTime() <= Date.now() ||
          row.secret.selectedDeviceId !== deviceId
        )
          throw changed();
        const devices = await this.provider.devices(tokens.accessToken);
        if (!devices.some((d) => d.id === deviceId && !d.restricted))
          throw new MusicFailure(
            409,
            "device_unavailable",
            "The selected player is no longer available. Refresh your players.",
          );
        // The durable reservation was committed BEFORE this non-idempotent provider operation.
        // A lost response/process restart can therefore never automatically replay queue/next.
        await this.provider.command(tokens.accessToken, action, deviceId, uri);
        const [saved] = await tx
          .update(commands)
          .set({
            status: "accepted",
            code: null,
            message:
              "Spotify accepted the command. Playback state below is reported separately by the player.",
          })
          .where(eq(commands.id, commandId))
          .returning();
        await tx
          .update(credentials)
          .set({ commandLeaseId: null, commandLeaseUntil: null })
          .where(eq(credentials.connectionId, id));
        return receipt(saved, false);
      });
    } catch (error) {
      const failure = asFailure(error);
      const uncertain = [
        "provider_timeout",
        "provider_unavailable",
        "connection_unavailable",
      ].includes(failure.code);
      const [saved] = await this.db
        .update(commands)
        .set({
          status: uncertain ? "uncertain" : "rejected",
          code: failure.code,
          message: uncertain
            ? "The command outcome is unknown. Check the player before sending a new action."
            : failure.message,
        })
        .where(
          and(
            eq(commands.id, commandId),
            eq(commands.requestHash, requestHash),
          ),
        )
        .returning();
      await this.db
        .update(credentials)
        .set({ commandLeaseId: null, commandLeaseUntil: null })
        .where(
          and(
            eq(credentials.connectionId, id),
            eq(credentials.commandLeaseId, commandId),
          ),
        );
      return saved
        ? receipt(saved, false)
        : {
            id: commandId,
            status: "uncertain",
            code: "connection_changed",
            message: "The connection changed. Check the player directly.",
            replay: false,
          };
    }
  }
}
