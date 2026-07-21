import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export const PERFORMER_PASSWORD_MIN_LENGTH = 3;
export const DEFAULT_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX = 5;
export const DEFAULT_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

type FailureBucket = {
  timestamps: number[];
};

function parsePositiveInteger(rawValue: string | undefined, fallbackValue: number) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }
  return Math.floor(parsed);
}

async function deriveScryptKey(
  password: string,
  salt: string,
  keyLength: number,
  options: {
    cost: number;
    blockSize: number;
    parallelization: number;
  }
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(Buffer.from(derivedKey));
    });
  });
}

function buildPasswordHashStorageValue(input: {
  cost: number;
  blockSize: number;
  parallelization: number;
  saltHex: string;
  derivedKeyHex: string;
}) {
  return `scrypt$${input.cost}$${input.blockSize}$${input.parallelization}$${input.saltHex}$${input.derivedKeyHex}`;
}

function parsePasswordHashStorageValue(encodedHash: string) {
  const parts = encodedHash.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  const saltHex = parts[4];
  const derivedKeyHex = parts[5];

  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return null;
  }

  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(derivedKeyHex)) {
    return null;
  }

  return {
    cost,
    blockSize,
    parallelization,
    saltHex,
    derivedKeyHex
  };
}

export function normalizePerformerPassword(rawValue: unknown) {
  if (typeof rawValue !== 'string') return null;
  if (rawValue.length === 0) return null;
  return rawValue;
}

export function validatePerformerPasswordStrength(password: string) {
  if (password.length < PERFORMER_PASSWORD_MIN_LENGTH) {
    return {
      ok: false as const,
      error: `Password must be at least ${PERFORMER_PASSWORD_MIN_LENGTH} characters.`
    };
  }

  // Allow short numeric quick-access passwords (e.g. 123) for claim handoff.
  if (/^\d{3,7}$/.test(password)) {
    return { ok: true as const };
  }

  if (password.length < 8) {
    return {
      ok: false as const,
      error: 'Use at least 8 characters with a letter and a number, or a short numeric code like 123.'
    };
  }

  if (!/[a-z]/i.test(password) || !/\d/.test(password)) {
    return {
      ok: false as const,
      error: 'Password must include at least one letter and one number.'
    };
  }

  return { ok: true as const };
}

export async function hashPerformerPassword(password: string) {
  const cost = 16384;
  const blockSize = 8;
  const parallelization = 1;
  const saltHex = randomBytes(16).toString('hex');
  const derivedKey = await deriveScryptKey(password, saltHex, 64, {
    cost,
    blockSize,
    parallelization
  });

  return buildPasswordHashStorageValue({
    cost,
    blockSize,
    parallelization,
    saltHex,
    derivedKeyHex: derivedKey.toString('hex')
  });
}

export async function verifyPerformerPassword(password: string, encodedHash: string | null | undefined) {
  if (!encodedHash) return false;

  const parsedHash = parsePasswordHashStorageValue(encodedHash);
  if (!parsedHash) return false;

  const derivedKey = await deriveScryptKey(password, parsedHash.saltHex, parsedHash.derivedKeyHex.length / 2, {
    cost: parsedHash.cost,
    blockSize: parsedHash.blockSize,
    parallelization: parsedHash.parallelization
  });

  const derivedBuffer = derivedKey;
  const expectedBuffer = Buffer.from(parsedHash.derivedKeyHex, 'hex');

  if (derivedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(derivedBuffer, expectedBuffer);
}

export function createPerformerPasswordLoginRateLimiter({
  maxFailures = parsePositiveInteger(
    process.env.SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX,
    DEFAULT_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_MAX
  ),
  windowMs = parsePositiveInteger(
    process.env.SWAY_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MS,
    DEFAULT_PERFORMER_PASSWORD_LOGIN_RATE_LIMIT_WINDOW_MS
  )
}: {
  maxFailures?: number;
  windowMs?: number;
} = {}) {
  const buckets = new Map<string, FailureBucket>();

  function readBucket(bucketKey: string, now: number) {
    const activeWindowStart = now - windowMs;
    const bucket = buckets.get(bucketKey) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > activeWindowStart);
    buckets.set(bucketKey, bucket);
    return bucket;
  }

  function bucketKey(requesterIpHash: string, accountKey: string) {
    return `${requesterIpHash}:${accountKey}`;
  }

  return {
    maxFailures,
    windowMs,

    check({
      requesterIpHash,
      accountKey,
      now = Date.now()
    }: {
      requesterIpHash: string;
      accountKey: string;
      now?: number;
    }) {
      const bucket = readBucket(bucketKey(requesterIpHash, accountKey), now);
      if (bucket.timestamps.length >= maxFailures) {
        return {
          allowed: false as const,
          retryAfterMs: Math.max(0, windowMs - (now - bucket.timestamps[0]))
        };
      }

      return {
        allowed: true as const,
        retryAfterMs: 0
      };
    },

    recordFailure({
      requesterIpHash,
      accountKey,
      now = Date.now()
    }: {
      requesterIpHash: string;
      accountKey: string;
      now?: number;
    }) {
      const bucket = readBucket(bucketKey(requesterIpHash, accountKey), now);
      bucket.timestamps.push(now);
      buckets.set(bucketKey(requesterIpHash, accountKey), bucket);

      return {
        failures: bucket.timestamps.length
      };
    },

    reset({
      requesterIpHash,
      accountKey
    }: {
      requesterIpHash: string;
      accountKey: string;
    }) {
      buckets.delete(bucketKey(requesterIpHash, accountKey));
    }
  };
}
