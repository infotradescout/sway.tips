import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
export class MusicFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const randomSecret = () => randomBytes(32).toString("base64url");
export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function encryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const value = env.SWAY_MUSIC_TOKEN_KEY ?? "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value)
    throw new MusicFailure(
      503,
      "setup_required",
      "Music account connection is not configured on Sway yet.",
    );
  return key;
}
export function seal(value: unknown, key: Buffer, context: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}
export function unseal<T>(value: string, key: Buffer, context: string): T {
  try {
    const pieces = value.split(".");
    if (pieces.length !== 4 || pieces[0] !== "v1")
      throw new Error("Unsupported envelope");
    const iv = Buffer.from(pieces[1], "base64url"),
      tag = Buffer.from(pieces[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16)
      throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(pieces[3], "base64url")),
        decipher.final(),
      ]).toString("utf8"),
    ) as T;
  } catch {
    throw new MusicFailure(
      409,
      "reconnect_required",
      "Reconnect this music account before continuing.",
    );
  }
}
export function appOrigin(env: NodeJS.ProcessEnv): string {
  try {
    const u = new URL(env.SWAY_APP_BASE_URL ?? "");
    const local =
      env.NODE_ENV === "test" &&
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(u.hostname);
    if (
      (u.protocol !== "https:" && !local) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== "/"
    )
      throw new Error();
    return u.origin;
  } catch {
    throw new MusicFailure(
      503,
      "setup_required",
      "Music account connection is not configured on Sway yet.",
    );
  }
}
export function availability(
  env: NodeJS.ProcessEnv,
): "available" | "setup_required" | "approval_required" {
  // Standard Spotify terms prohibit business/public-playback and commercial streaming apps.
  // This operator-owned reference must identify actual approval of the intended Sway use.
  // Neither a user checkbox nor a successful OAuth response supplies that approval.
  if (
    env.SWAY_SPOTIFY_DIRECT_USE_APPROVED !== "true" ||
    !(env.SWAY_SPOTIFY_DIRECT_APPROVAL_REFERENCE ?? "").trim()
  )
    return "approval_required";
  try {
    appOrigin(env);
    encryptionKey(env);
    if (!/^[a-fA-F0-9]{32}$/.test(env.SWAY_SPOTIFY_CLIENT_ID ?? ""))
      throw new Error();
    return "available";
  } catch {
    return "setup_required";
  }
}
export function requireAvailable(env: NodeJS.ProcessEnv): void {
  const status = availability(env);
  if (status !== "available")
    throw new MusicFailure(
      503,
      status,
      status === "approval_required"
        ? "Spotify connection is awaiting provider approval for Sway’s use. File imports are not a replacement for this connection."
        : "Music account connection is not configured on Sway yet.",
    );
}
export const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function requireUuid(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new MusicFailure(
      422,
      "invalid_request",
      "Refresh your music connection and try again.",
    );
  return value;
}
