import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { hashPerformerLoginRequesterIp } from '../src/server/performer-login';
import {
  canonicalizeClientIp,
  configureExpressTrustedProxyBoundary,
  createTrustedProxyBoundaryMiddleware,
  parseTrustedProxyCidrs,
  resolveCanonicalRequestIp,
  SWAY_TRUSTED_PROXY_CIDRS_ENV
} from '../src/server/trusted-proxy';

type IpResponse = {
  ip?: string | null;
  ipHash?: string | null;
  code?: string;
};

async function withProxyProofServer(
  environment: Readonly<Record<string, string | undefined>>,
  proof: (
    baseUrl: string,
    boundary: ReturnType<typeof configureExpressTrustedProxyBoundary>
  ) => Promise<void>
) {
  const app = express();
  const boundary = configureExpressTrustedProxyBoundary(app, environment);
  app.use(createTrustedProxyBoundaryMiddleware());
  app.get('/ip', (req, res) => {
    const ip = resolveCanonicalRequestIp(req);
    res.json({
      ip,
      ipHash: ip ? hashPerformerLoginRequesterIp(ip) : null
    });
  });

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listeningServer = app.listen(0, '127.0.0.1', () => resolve(listeningServer));
  });
  const address = server.address() as AddressInfo;

  try {
    await proof(`http://127.0.0.1:${address.port}`, boundary);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function requestIp(baseUrl: string, forwardedFor?: string) {
  const response = await fetch(`${baseUrl}/ip`, {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : undefined
  });
  return {
    status: response.status,
    body: await response.json() as IpResponse
  };
}

async function main() {
  assert.equal(canonicalizeClientIp('::ffff:198.51.100.9'), '198.51.100.9');
  assert.equal(
    canonicalizeClientIp('2001:0db8:0000:0000:0000:0000:0000:0001'),
    canonicalizeClientIp('2001:db8::1'),
    'Equivalent IPv6 spellings must collapse to one rate-limit identity.'
  );
  assert.deepEqual(parseTrustedProxyCidrs(undefined), []);
  assert.throws(
    () => parseTrustedProxyCidrs('true'),
    /literal IP addresses and CIDRs only/,
    'Boolean trust-proxy shortcuts must be rejected.'
  );
  assert.throws(
    () => parseTrustedProxyCidrs('0.0.0.0/0'),
    /cannot trust an all-address network/,
    'An all-address proxy boundary must be rejected.'
  );
  assert.throws(
    () => parseTrustedProxyCidrs('127.0.0.1/32,'),
    /non-empty IP or CIDR entries/,
    'Malformed comma-separated configuration must fail closed.'
  );

  await withProxyProofServer({}, async (baseUrl, boundary) => {
    assert.equal(boundary.mode, 'direct');
    const direct = await requestIp(baseUrl);
    assert.equal(direct.status, 200);
    assert.equal(direct.body.ip, '127.0.0.1');

    const spoofed = await requestIp(baseUrl, '198.51.100.44');
    assert.equal(spoofed.status, 400);
    assert.equal(spoofed.body.code, 'untrusted_forwarding_headers');
  });

  await withProxyProofServer({
    [SWAY_TRUSTED_PROXY_CIDRS_ENV]: '10.0.0.0/8'
  }, async (baseUrl, boundary) => {
    assert.equal(boundary.mode, 'cidr');
    const spoofedFromUntrustedSocket = await requestIp(baseUrl, '198.51.100.45');
    assert.equal(spoofedFromUntrustedSocket.status, 400);
    assert.equal(spoofedFromUntrustedSocket.body.code, 'untrusted_forwarding_headers');
  });

  await withProxyProofServer({
    [SWAY_TRUSTED_PROXY_CIDRS_ENV]: '127.0.0.1/32,::1/128'
  }, async (baseUrl, boundary) => {
    assert.equal(boundary.mode, 'cidr');
    const firstClient = await requestIp(baseUrl, '198.51.100.10');
    const secondClient = await requestIp(baseUrl, '198.51.100.11');
    assert.equal(firstClient.status, 200);
    assert.equal(secondClient.status, 200);
    assert.equal(firstClient.body.ip, '198.51.100.10');
    assert.equal(secondClient.body.ip, '198.51.100.11');
    assert.notEqual(
      firstClient.body.ipHash,
      secondClient.body.ipHash,
      'Distinct clients behind the trusted proxy must receive distinct report-ceiling identities.'
    );

    const spoofedLeftmostHop = await requestIp(baseUrl, '203.0.113.200, 198.51.100.12');
    assert.equal(spoofedLeftmostHop.status, 200);
    assert.equal(
      spoofedLeftmostHop.body.ip,
      '198.51.100.12',
      'The first untrusted hop nearest the configured proxy must be the client identity.'
    );

    const malformed = await requestIp(baseUrl, 'not-an-ip');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'invalid_client_ip');
  });

  await withProxyProofServer({
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web'
  }, async (baseUrl, boundary) => {
    assert.equal(boundary.mode, 'render');
    const forwardedClient = await requestIp(baseUrl, '198.51.100.46');
    assert.equal(forwardedClient.status, 200);
    assert.equal(forwardedClient.body.ip, '198.51.100.46');
  });

  assert.throws(
    () => configureExpressTrustedProxyBoundary(express(), {
      RENDER: 'true',
      RENDER_SERVICE_TYPE: 'web',
      [SWAY_TRUSTED_PROXY_CIDRS_ENV]: '127.0.0.1/32'
    }),
    /must be empty on Render web services/,
    'Render mode must not pretend an operator-supplied CIDR models its private load-balancer chain.'
  );

  console.log('Trusted Express proxy boundary integration test passed.');
}

main().catch((error) => {
  console.error('Trusted Express proxy boundary integration test failed:');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
