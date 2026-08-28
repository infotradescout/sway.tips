import assert from 'node:assert/strict';
import { routeFamilyGuard } from '../src/server/access-control';
import { INACTIVE_PERFORMER_WORKSPACE_PATHS } from '../src/performer-workspace-routing';

type ResponseCapture = {
  redirect: string | null;
  status: number | null;
  body: unknown;
  nextCalled: boolean;
};

async function runGuard(input: {
  pathname: string;
  originalUrl?: string;
  status?: number;
  accept?: string;
}) {
  const capture: ResponseCapture = {
    redirect: null,
    status: null,
    body: null,
    nextCalled: false
  };
  const request = {
    method: 'GET',
    path: input.pathname,
    originalUrl: input.originalUrl ?? input.pathname,
    headers: {
      accept: input.accept ?? 'text/html',
      'x-sway-shell': 'talent'
    }
  };
  const response = {
    redirect(location: string) {
      capture.redirect = location;
      return this;
    },
    status(status: number) {
      capture.status = status;
      return this;
    },
    set() {
      return this;
    },
    send(body: unknown) {
      capture.body = body;
      return this;
    },
    json(body: unknown) {
      capture.body = body;
      return this;
    }
  };
  const accessControl = {
    requireTalentAccess: async () => ({
      allowed: false as const,
      status: input.status ?? 401,
      reason: input.status === 403 ? 'Performer role required.' : 'Authentication required.'
    })
  };

  await routeFamilyGuard(accessControl as any)(
    request as any,
    response as any,
    () => { capture.nextCalled = true; }
  );
  return capture;
}

for (const workspacePath of Object.values(INACTIVE_PERFORMER_WORKSPACE_PATHS)) {
  const capture = await runGuard({ pathname: workspacePath });
  assert.equal(
    capture.redirect,
    `/talent/login?redirect=${encodeURIComponent(workspacePath)}`,
    `Unauthenticated ${workspacePath} must retain its exact post-login destination.`
  );
  assert.equal(capture.nextCalled, false);
}

const trailingShows = await runGuard({ pathname: '/talent/shows/', originalUrl: '/talent/shows/?ignored=1' });
assert.equal(
  trailingShows.redirect,
  '/talent/login?redirect=%2Ftalent%2Fshows',
  'A trailing slash must canonicalize without forwarding unrelated query state.'
);

const nestedUnknown = await runGuard({ pathname: '/talent/shows/upcoming' });
assert.equal(nestedUnknown.redirect, null, 'Unknown nested performer paths must not enter the workspace allowlist.');
assert.equal(nestedUnknown.status, 401);
assert.match(String(nestedUnknown.body), /Session needed/);

const forbiddenWorkspace = await runGuard({ pathname: '/talent/shows', status: 403 });
assert.equal(forbiddenWorkspace.redirect, null, 'Authorization failures must not be converted into login redirects.');
assert.equal(forbiddenWorkspace.status, 403);

const jsonRequest = await runGuard({ pathname: '/talent/shows', accept: 'application/json' });
assert.equal(jsonRequest.redirect, null, 'Non-HTML callers must keep the JSON error contract.');
assert.equal(jsonRequest.status, 401);
assert.deepEqual(jsonRequest.body, { error: 'Authentication required.' });

console.log('Performer workspace access recovery behavior passed.');
