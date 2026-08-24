import { isIP } from 'node:net';
import type { Express, Request, RequestHandler } from 'express';

export const SWAY_TRUSTED_PROXY_CIDRS_ENV = 'SWAY_TRUSTED_PROXY_CIDRS';

const FORWARDED_CLIENT_IDENTITY_HEADERS = [
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip'
] as const;

export type TrustedProxyBoundary = Readonly<{
  enabled: boolean;
  mode: 'direct' | 'render' | 'cidr';
  cidrs: readonly string[];
}>;

type TrustedProxyEnvironment = Readonly<Record<string, string | undefined>>;

function canonicalizeIpv6(address: string): string | null {
  try {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1).toLowerCase()
      : hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function canonicalizeClientIp(rawAddress: string | null | undefined): string | null {
  if (typeof rawAddress !== 'string') return null;
  let address = rawAddress.trim();
  if (!address) return null;

  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }

  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mappedIpv4 && isIP(mappedIpv4) === 4) {
    return mappedIpv4.split('.').map((part) => String(Number(part))).join('.');
  }

  const version = isIP(address);
  if (version === 4) {
    return address.split('.').map((part) => String(Number(part))).join('.');
  }
  if (version === 6) return canonicalizeIpv6(address);
  return null;
}

export function parseTrustedProxyCidrs(rawValue: string | null | undefined): readonly string[] {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return Object.freeze([]);

  const rawEntries = rawValue.split(',');
  if (rawEntries.length > 64 || rawEntries.some((entry) => !entry.trim())) {
    throw new Error(`${SWAY_TRUSTED_PROXY_CIDRS_ENV} must contain 1-64 non-empty IP or CIDR entries.`);
  }

  const cidrs = rawEntries.map((rawEntry) => {
    const entry = rawEntry.trim();
    const slashParts = entry.split('/');
    if (slashParts.length > 2) {
      throw new Error(`${SWAY_TRUSTED_PROXY_CIDRS_ENV} contains an invalid CIDR entry.`);
    }

    const address = slashParts[0];
    const version = isIP(address);
    if (!version) {
      throw new Error(`${SWAY_TRUSTED_PROXY_CIDRS_ENV} accepts literal IP addresses and CIDRs only.`);
    }

    if (slashParts.length === 1) {
      return version === 4
        ? address.split('.').map((part) => String(Number(part))).join('.')
        : canonicalizeIpv6(address) ?? address.toLowerCase();
    }

    const prefixText = slashParts[1];
    if (!/^(?:0|[1-9]\d*)$/.test(prefixText)) {
      throw new Error(`${SWAY_TRUSTED_PROXY_CIDRS_ENV} contains an invalid CIDR prefix.`);
    }
    const prefix = Number(prefixText);
    const maximumPrefix = version === 4 ? 32 : 128;
    if (prefix < 1 || prefix > maximumPrefix) {
      throw new Error(`${SWAY_TRUSTED_PROXY_CIDRS_ENV} cannot trust an all-address network or invalid prefix.`);
    }
    return `${address.toLowerCase()}/${prefix}`;
  });

  return Object.freeze([...new Set(cidrs)]);
}

export function configureExpressTrustedProxyBoundary(
  app: Pick<Express, 'set'>,
  environment: TrustedProxyEnvironment = process.env
): TrustedProxyBoundary {
  const cidrs = parseTrustedProxyCidrs(environment[SWAY_TRUSTED_PROXY_CIDRS_ENV]);

  const runningOnRenderWebService = environment.RENDER === 'true'
    && environment.RENDER_SERVICE_TYPE === 'web';
  if (runningOnRenderWebService) {
    if (cidrs.length > 0) {
      throw new Error(
        `${SWAY_TRUSTED_PROXY_CIDRS_ENV} must be empty on Render web services; `
        + 'Render owns the final proxy boundary and forwarded client identity.'
      );
    }

    // Render web ports are not directly reachable: every inbound request
    // crosses Render's edge and load balancers. Render documents the left-most
    // X-Forwarded-For value as the client identity, so Express may trust that
    // platform-owned chain only when Render's runtime markers are both present.
    app.set('trust proxy', true);
    return Object.freeze({ enabled: true, mode: 'render', cidrs });
  }

  app.set('trust proxy', cidrs.length ? [...cidrs] : false);
  return Object.freeze({
    enabled: cidrs.length > 0,
    mode: cidrs.length > 0 ? 'cidr' : 'direct',
    cidrs
  });
}

function hasForwardedClientIdentityHeader(req: Request): boolean {
  return FORWARDED_CLIENT_IDENTITY_HEADERS.some((headerName) => {
    const value = req.headers[headerName];
    return Array.isArray(value)
      ? value.some((entry) => entry.trim().length > 0)
      : typeof value === 'string' && value.trim().length > 0;
  });
}

export function createTrustedProxyBoundaryMiddleware(): RequestHandler {
  return (req, res, next) => {
    // Express only populates req.ips when the direct socket peer is trusted.
    // Reject, rather than silently use, client-supplied forwarding identity
    // headers that did not cross the configured proxy boundary.
    if (hasForwardedClientIdentityHeader(req) && req.ips.length === 0) {
      res.status(400).json({
        error: 'Forwarded client identity headers require a trusted proxy boundary.',
        code: 'untrusted_forwarding_headers'
      });
      return;
    }

    if (!canonicalizeClientIp(req.ip)) {
      res.status(400).json({
        error: 'A valid client network address is required.',
        code: 'invalid_client_ip'
      });
      return;
    }

    next();
  };
}

export function resolveCanonicalRequestIp(req: Pick<Request, 'ip'>): string | null {
  return canonicalizeClientIp(req.ip);
}
