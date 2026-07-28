import { lookup as dnsLookup } from 'node:dns';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export const SAFE_REMOTE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const SAFE_REMOTE_IMAGE_MAX_PIXELS = 25_000_000;
const SAFE_REMOTE_IMAGE_TIMEOUT_MS = 3_500;
const SAFE_REMOTE_IMAGE_MAX_REDIRECTS = 2;

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.internal',
  '.lan',
  '.local',
  '.localhost',
  '.home'
];

function ipv4ToNumber(address: string) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(address: number, base: string, prefixLength: number) {
  const baseNumber = ipv4ToNumber(base);
  if (baseNumber === null) return false;
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

const BLOCKED_IPV4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
];

function parseIpv6(address: string) {
  let normalized = address.toLowerCase().split('%')[0];
  if (normalized.includes('.')) {
    const finalColon = normalized.lastIndexOf(':');
    const embeddedIpv4 = ipv4ToNumber(normalized.slice(finalColon + 1));
    if (embeddedIpv4 === null) return null;
    normalized = `${normalized.slice(0, finalColon)}:${((embeddedIpv4 >>> 16) & 0xffff).toString(16)}:${(embeddedIpv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;

  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  return groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
}

function ipv6InCidr(address: bigint, base: string, prefixLength: number) {
  const baseNumber = parseIpv6(base);
  if (baseNumber === null) return false;
  const hostBits = BigInt(128 - prefixLength);
  return (address >> hostBits) === (baseNumber >> hostBits);
}

const BLOCKED_IPV6_RANGES: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
];

export function isPublicIpAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const parsed = ipv4ToNumber(address);
    return parsed !== null && !BLOCKED_IPV4_RANGES.some(([base, prefix]) => ipv4InCidr(parsed, base, prefix));
  }
  if (family === 6) {
    const parsed = parseIpv6(address);
    if (parsed === null) return false;

    const ipv4MappedPrefix = 0xffffn;
    if ((parsed >> 32n) === ipv4MappedPrefix) {
      const mapped = Number(parsed & 0xffffffffn);
      const mappedAddress = [
        (mapped >>> 24) & 0xff,
        (mapped >>> 16) & 0xff,
        (mapped >>> 8) & 0xff,
        mapped & 0xff
      ].join('.');
      return isPublicIpAddress(mappedAddress);
    }

    return !BLOCKED_IPV6_RANGES.some(([base, prefix]) => ipv6InCidr(parsed, base, prefix));
  }
  return false;
}

function normalizedHostname(url: URL) {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

export function assertSafeRemoteImageUrl(rawUrl: string | URL) {
  const url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Remote profile images must use HTTPS.');
  if (url.username || url.password) throw new Error('Remote profile images cannot include URL credentials.');
  if (url.port && url.port !== '443') throw new Error('Remote profile images must use the standard HTTPS port.');

  const hostname = normalizedHostname(url);
  if (
    hostname === 'localhost'
    || BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new Error('Remote profile image host is not publicly routable.');
  }
  if (isIP(hostname) && !isPublicIpAddress(hostname)) {
    throw new Error('Remote profile image host resolves to a private or reserved address.');
  }
  return url;
}

async function resolvePublicAddress(hostname: string) {
  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) throw new Error('Remote profile image host is not public.');
    return { address: hostname, family: isIP(hostname) };
  }

  const addresses = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
  if (!addresses.length || addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new Error('Remote profile image host did not resolve exclusively to public addresses.');
  }
  return addresses[0];
}

function readContentType(response: IncomingMessage) {
  const raw = response.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.split(';')[0]?.trim().toLowerCase() ?? '';
}

function validateResponseMetadata(response: IncomingMessage) {
  const contentType = readContentType(response);
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error('Remote profile image returned an unsupported content type.');
  }

  const rawLength = response.headers['content-length'];
  const lengthValue = Array.isArray(rawLength) ? rawLength[0] : rawLength;
  if (lengthValue) {
    const contentLength = Number(lengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > SAFE_REMOTE_IMAGE_MAX_BYTES) {
      throw new Error('Remote profile image is too large.');
    }
  }
  return contentType;
}

export function assertSupportedImagePayload(body: Buffer, contentType: string) {
  const isJpeg = body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff;
  const isPng = body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = body.length >= 12
    && body.subarray(0, 4).toString('ascii') === 'RIFF'
    && body.subarray(8, 12).toString('ascii') === 'WEBP';

  const matches = (
    (contentType === 'image/jpeg' && isJpeg)
    || (contentType === 'image/png' && isPng)
    || (contentType === 'image/webp' && isWebp)
  );
  if (!matches) throw new Error('Remote profile image bytes do not match the declared image type.');
}

async function downloadRemoteImage(url: URL, redirectsRemaining: number): Promise<Buffer> {
  const safeUrl = assertSafeRemoteImageUrl(url);
  const hostname = normalizedHostname(safeUrl);
  const resolvedAddress = await resolvePublicAddress(hostname);

  return new Promise<Buffer>((resolve, reject) => {
    const request = httpsRequest(safeUrl, {
      method: 'GET',
      headers: {
        Accept: 'image/png,image/jpeg,image/webp',
        'User-Agent': 'SwayShareCard/1.0'
      },
      lookup: (_requestedHostname: string, _options: unknown, callback: (...args: any[]) => void) => {
        callback(null, resolvedAddress.address, resolvedAddress.family);
      },
      servername: isIP(hostname) ? undefined : hostname
    }, (response) => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location || redirectsRemaining <= 0) {
          reject(new Error('Remote profile image exceeded the redirect limit.'));
          return;
        }
        let redirectedUrl: URL;
        try {
          redirectedUrl = assertSafeRemoteImageUrl(new URL(location, safeUrl));
        } catch (error) {
          reject(error);
          return;
        }
        void downloadRemoteImage(redirectedUrl, redirectsRemaining - 1).then(resolve, reject);
        return;
      }

      if (status !== 200) {
        response.resume();
        reject(new Error(`Remote profile image returned HTTP ${status}.`));
        return;
      }

      let contentType: string;
      try {
        contentType = validateResponseMetadata(response);
      } catch (error) {
        response.destroy();
        reject(error);
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > SAFE_REMOTE_IMAGE_MAX_BYTES) {
          response.destroy(new Error('Remote profile image exceeded the byte limit.'));
          return;
        }
        chunks.push(buffer);
      });
      response.once('error', reject);
      response.once('end', () => {
        try {
          const body = Buffer.concat(chunks, totalBytes);
          assertSupportedImagePayload(body, contentType);
          resolve(body);
        } catch (error) {
          reject(error);
        }
      });
    });

    request.setTimeout(SAFE_REMOTE_IMAGE_TIMEOUT_MS, () => {
      request.destroy(new Error('Remote profile image request timed out.'));
    });
    request.once('error', reject);
    request.end();
  });
}

export async function fetchSafeRemoteImage(rawUrl: string) {
  return downloadRemoteImage(assertSafeRemoteImageUrl(rawUrl), SAFE_REMOTE_IMAGE_MAX_REDIRECTS);
}
