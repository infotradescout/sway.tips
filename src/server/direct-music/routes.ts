import { Router, type Express, type Request, type Response } from "express";
import type { SwayDb } from "../../db/client";
import type { MusicCommandAction } from "../../direct-music";
import { DirectMusicService, type MusicScope } from "./service";
import { appOrigin, MusicFailure, requireUuid } from "./security";
import { SpotifyDirectProvider } from "./spotify";
type Access =
  | { allowed: true; actor: { actorId?: string | null } }
  | { allowed: false; status: number; reason: string };
export function createDirectMusicRouter(options: {
  db: SwayDb | null;
  authorize: (req: Request) => Promise<Access>;
  env: NodeJS.ProcessEnv;
  provider?: SpotifyDirectProvider;
}) {
  const router = Router(),
    service = options.db
      ? new DirectMusicService(options.db, options.env, options.provider)
      : null;
  const cookieName =
    options.env.NODE_ENV === "production"
      ? "__Host-sway-music-oauth"
      : "sway-music-oauth";
  const cookieOptions = {
    httpOnly: true,
    secure: options.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  async function actor(req: Request) {
    const access = await options.authorize(req);
    if (access.allowed === false)
      throw new MusicFailure(access.status, "sign_in_required", access.reason);
    if (!access.actor.actorId)
      throw new MusicFailure(
        401,
        "sign_in_required",
        "Sign in to your Sway account.",
      );
    return access.actor.actorId;
  }
  async function scope(req: Request): Promise<MusicScope> {
    return {
      actorId: await actor(req),
      performerId: requireUuid(
        req.method === "GET" ? req.query.performerId : req.body?.performerId,
      ),
    };
  }
  function ready() {
    if (!service)
      throw new MusicFailure(
        503,
        "connection_unavailable",
        "Music connection storage is temporarily unavailable.",
      );
    return service;
  }
  function mutation(req: Request) {
    if (
      req.headers.origin !== appOrigin(options.env) ||
      !["same-origin", "same-site", undefined].includes(
        req.headers["sec-fetch-site"] as string | undefined,
      )
    )
      throw new MusicFailure(
        403,
        "invalid_origin",
        "Open Sway directly before connecting or controlling music.",
      );
    if (!req.is("application/json"))
      throw new MusicFailure(
        415,
        "invalid_request",
        "Music actions require JSON.",
      );
  }
  function respond(res: Response, error: unknown) {
    const problem =
      error instanceof MusicFailure
        ? error
        : new MusicFailure(
            503,
            "connection_unavailable",
            "The music connection could not be confirmed. Refresh before repeating an action.",
          );
    if (problem.retryAfter)
      res.setHeader("Retry-After", String(problem.retryAfter));
    return res
      .status(problem.status)
      .json({
        error: problem.message,
        code: problem.code,
        ...(problem.retryAfter
          ? { retryAfterSeconds: problem.retryAfter }
          : {}),
      });
  }
  const route =
    (work: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        await work(req, res);
      } catch (error) {
        respond(res, error);
      }
    };
  router.get(
    "/",
    route(async (req, res) => {
      res.json(await ready().overview(await scope(req)));
    }),
  );
  router.post(
    "/spotify/connect",
    route(async (req, res) => {
      mutation(req);
      const owner = await scope(req),
        value = req.body?.expectedConnection;
      const expected =
        value === null
          ? null
          : {
              id: requireUuid(value?.id),
              revision: requireUuid(value?.revision),
            };
      const result = await ready().begin(owner, expected);
      res.cookie(cookieName, result.browser, {
        ...cookieOptions,
        expires: result.expiresAt,
      });
      res.json({
        performerId: owner.performerId,
        authorizationUrl: result.url,
        expiresAt: result.expiresAt.toISOString(),
      });
    }),
  );
  router.get("/spotify/callback", async (req, res) => {
    try {
      const actorId = await actor(req);
      const cookies = String(req.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim().split("="));
      const found = cookies.filter(([name]) => name === cookieName);
      if (found.length !== 1)
        throw new MusicFailure(
          409,
          "oauth_expired",
          "Restart connection from Sources.",
        );
      if (
        typeof req.query.state !== "string" ||
        (req.query.code !== undefined && typeof req.query.code !== "string") ||
        (req.query.error !== undefined &&
          typeof req.query.error !== "string") ||
        (req.query.code && req.query.error)
      )
        throw new MusicFailure(
          422,
          "invalid_request",
          "Invalid account authorization response.",
        );
      const code =
        typeof req.query.code === "string" && req.query.code.length <= 8192
          ? req.query.code
          : null;
      await ready().finish(actorId, req.query.state, found[0][1], code);
      res.clearCookie(cookieName, cookieOptions);
      res.redirect(303, "/talent/connections?direct_music=connected");
    } catch (error) {
      res.clearCookie(cookieName, cookieOptions);
      const code =
        error instanceof MusicFailure ? error.code : "connection_unavailable";
      // No OAuth code, token, provider response body or user-supplied redirect enters the URL or logs.
      res.redirect(
        303,
        "/talent/connections?direct_music_error=" + encodeURIComponent(code),
      );
    }
  });
  router.get(
    "/:id/read",
    route(async (req, res) => {
      const owner = await scope(req),
        id = requireUuid(req.params.id),
        revision = requireUuid(req.query.revision);
      const kinds = [
        "devices",
        "playback",
        "playlists",
        "playlist",
        "saved",
        "search",
      ] as const;
      const kind = req.query.kind;
      if (
        typeof kind !== "string" ||
        !kinds.includes(kind as (typeof kinds)[number])
      )
        throw new MusicFailure(
          422,
          "invalid_request",
          "Choose a supported music view.",
        );
      const raw = req.query.offset ?? "0";
      if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw))
        throw new MusicFailure(422, "invalid_request", "Invalid page offset.");
      if (
        (req.query.query !== undefined &&
          typeof req.query.query !== "string") ||
        (req.query.playlistId !== undefined &&
          typeof req.query.playlistId !== "string")
      )
        throw new MusicFailure(422, "invalid_request", "Invalid music query.");
      res.json(
        await ready().read(
          owner,
          id,
          revision,
          kind as (typeof kinds)[number],
          Number(raw),
          (req.query.query as string) ?? "",
          (req.query.playlistId as string) ?? "",
        ),
      );
    }),
  );
  router.post(
    "/:id/target",
    route(async (req, res) => {
      mutation(req);
      const owner = await scope(req);
      if (typeof req.body?.deviceId !== "string")
        throw new MusicFailure(422, "invalid_request", "Choose a player.");
      res.json(
        await ready().target(
          owner,
          requireUuid(req.params.id),
          requireUuid(req.body?.revision),
          req.body.deviceId,
        ),
      );
    }),
  );
  router.post(
    "/:id/disconnect",
    route(async (req, res) => {
      mutation(req);
      res.json(
        await ready().disconnect(
          await scope(req),
          requireUuid(req.params.id),
          requireUuid(req.body?.revision),
        ),
      );
    }),
  );
  router.post(
    "/:id/commands",
    route(async (req, res) => {
      mutation(req);
      const result = await ready().command(
        await scope(req),
        requireUuid(req.params.id),
        requireUuid(req.body?.revision),
        requireUuid(req.body?.commandId),
        req.body?.action as MusicCommandAction,
        req.body?.deviceId,
        req.body?.uri,
      );
      res.status(result.status === "rejected" ? 409 : 202).json(result);
    }),
  );
  return router;
}
export function registerDirectMusicRoutes(options: {
  app: Express;
  db: SwayDb | null;
  authorize: (req: Request) => Promise<Access>;
  env: NodeJS.ProcessEnv;
}) {
  options.app.use("/api/talent/direct-music", createDirectMusicRouter(options));
}
