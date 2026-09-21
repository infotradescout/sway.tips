import assert from 'node:assert/strict';
import { describeCollaboratorFilePermissions } from '../src/components/CollaboratorInbox';
import { resolveFileConnectAccountIdentity } from '../src/components/FileConnectCard';
import { isInstallPromptSuppressedRoute } from '../src/shells/SwayInstallPrompt';
import {
  buildFileConnectLoginHref,
  FILE_COLLABORATION_PATHS,
  normalizeSafeAccountNextPath,
  preserveFileConnectFragment,
  readFilePairingTokenFromHash,
  resolveLegacyFileConnectTarget
} from '../src/file-collaboration-routing';

const validToken = `${'A'.repeat(40)}_-z`;
const validHash = `#token=${validToken}`;
const eventId = '11111111-1111-4111-8111-111111111111';

assert.deepEqual(
  resolveFileConnectAccountIdentity({ displayName: '  Alex Collaborator  ', email: 'alex@example.com' }),
  { label: 'Alex Collaborator', email: 'alex@example.com' }
);
assert.deepEqual(
  resolveFileConnectAccountIdentity({ displayName: null, email: '  alex@example.com  ' }),
  { label: 'alex@example.com', email: null }
);
assert.equal(resolveFileConnectAccountIdentity({ displayName: ' ', email: null }), null);
assert.equal(resolveFileConnectAccountIdentity(null), null);

assert.equal(validToken.length, 43, 'The fixture must exercise the exact pairing-token length.');
assert.equal(readFilePairingTokenFromHash(validHash), validToken);
assert.equal(readFilePairingTokenFromHash(`#token=${'_'.repeat(43)}`), '_'.repeat(43));

for (const malformedHash of [
  '',
  `token=${validToken}`,
  `#TOKEN=${validToken}`,
  `#token=${'A'.repeat(42)}`,
  `#token=${'A'.repeat(44)}`,
  `#token=${'A'.repeat(42)}=`,
  `#token=${'A'.repeat(42)}!`,
  `#token=${validToken}&extra=1`,
  `#token=${validToken}&token=${validToken}`,
  `#token=%41${'A'.repeat(42)}`,
  `#token=${validToken}%20`,
  ` #token=${validToken}`,
  `#token=${validToken} `,
  `#token=${validToken}\n`
]) {
  assert.equal(
    readFilePairingTokenFromHash(malformedHash),
    '',
    `Malformed, extra, duplicate, encoded, or whitespace-bearing token must fail closed: ${JSON.stringify(malformedHash)}`
  );
}

const loginHref = buildFileConnectLoginHref(validHash);
assert.equal(
  loginHref,
  `/account/login?next=%2Faccount%2Fcollaboration%2Fconnect${validHash}`,
  'Login continuation must carry only the canonical next path in the query and the secret in the fragment.'
);
const parsedLoginHref = new URL(loginHref, 'https://app.sway.tips');
assert.equal(parsedLoginHref.pathname, '/account/login');
assert.deepEqual([...parsedLoginHref.searchParams.entries()], [
  ['next', FILE_COLLABORATION_PATHS.connect]
]);
assert.equal(parsedLoginHref.hash, validHash);
assert.equal(parsedLoginHref.searchParams.has('token'), false);
assert.equal(parsedLoginHref.search.includes(validToken), false);
assert.equal(
  buildFileConnectLoginHref(`#token=${validToken}&extra=1`),
  '/account/login?next=%2Faccount%2Fcollaboration%2Fconnect',
  'An invalid fragment must never be forwarded to login.'
);

assert.equal(
  preserveFileConnectFragment(FILE_COLLABORATION_PATHS.connect, validHash),
  `${FILE_COLLABORATION_PATHS.connect}${validHash}`
);
assert.equal(
  preserveFileConnectFragment(FILE_COLLABORATION_PATHS.connect, `#token=${'A'.repeat(42)}`),
  FILE_COLLABORATION_PATHS.connect
);
assert.equal(
  preserveFileConnectFragment(FILE_COLLABORATION_PATHS.inbox, validHash),
  FILE_COLLABORATION_PATHS.inbox,
  'A file secret must attach only to the exact connect continuation.'
);
assert.equal(
  preserveFileConnectFragment(`${FILE_COLLABORATION_PATHS.connect}?extra=1`, validHash),
  `${FILE_COLLABORATION_PATHS.connect}?extra=1`,
  'A non-exact continuation must not receive a file secret.'
);
assert.equal(resolveLegacyFileConnectTarget(validHash), `${FILE_COLLABORATION_PATHS.connect}${validHash}`);
assert.equal(resolveLegacyFileConnectTarget(`#token=${validToken}&extra=1`), FILE_COLLABORATION_PATHS.connect);
assert.equal(resolveLegacyFileConnectTarget(''), FILE_COLLABORATION_PATHS.connect);

for (const allowedNext of [
  FILE_COLLABORATION_PATHS.inbox,
  FILE_COLLABORATION_PATHS.connect,
  '/talent/gigs',
  '/talent/connections',
  '/talent/shows',
  '/talent/music',
  '/talent/files',
  '/talent/profile',
  '/talent/account',
  `/e/${eventId}`,
  `/e/${eventId}?buy=1`,
  `/talent/events/${eventId}/door`,
  '/account?intent=performer'
]) {
  assert.equal(normalizeSafeAccountNextPath(allowedNext), allowedNext, `Expected safe account next path: ${allowedNext}`);
}

for (const unsafeNext of [
  `${FILE_COLLABORATION_PATHS.inbox}?extra=1`,
  `${FILE_COLLABORATION_PATHS.connect}?token=${validToken}`,
  `${FILE_COLLABORATION_PATHS.inbox}#token=${validToken}`,
  `${FILE_COLLABORATION_PATHS.connect}#token=${validToken}`,
  `${FILE_COLLABORATION_PATHS.inbox}/`,
  `/e/${eventId}?buy=1&buy=1`,
  `/e/${eventId}?buy=1&extra=1`,
  `/e/${eventId}?extra=1&buy=1`,
  `/e/${eventId}?buy=0`,
  `/e/${eventId}?buy=true`,
  `/e/${eventId}?buy=`,
  `/e/${eventId}?BUY=1`,
  `/e/${eventId}?buy=%31`,
  `/e/${eventId}?%62uy=1`,
  `/e/${eventId}?buy=1#checkout`,
  `/e/${eventId}?buy=1#`,
  '/e/11111111-1111-0111-8111-111111111111?buy=1',
  `/talent/events/${eventId}/door?token=${validToken}`,
  `/talent/events/${eventId}/door#token=${validToken}`,
  '/account/collaboration/other',
  '/admin',
  'https://evil.example/account/collaboration',
  '//evil.example/account/collaboration',
  'javascript:alert(1)',
  '/account?intent=performer&intent=performer',
  '/account?intent=performer&extra=1',
  '/account?extra=1&intent=performer',
  '/account?intent=patron',
  '/account?intent=performer#extra'
]) {
  assert.equal(normalizeSafeAccountNextPath(unsafeNext), '', `Unsafe account next path must fail closed: ${unsafeNext}`);
}

for (const [pathname, search] of [
  [FILE_COLLABORATION_PATHS.inbox, ''],
  [FILE_COLLABORATION_PATHS.connect, ''],
  ['/account/login', `?next=${encodeURIComponent(FILE_COLLABORATION_PATHS.connect)}`],
  ['/account/login', '?next=%2Ftickets'],
  ['/account/signup', `?next=${encodeURIComponent(FILE_COLLABORATION_PATHS.connect)}`],
  ['/talent/gigs', '']
] as const) {
  const expected = pathname !== '/account/signup';
  assert.equal(
    isInstallPromptSuppressedRoute(pathname, search),
    expected,
    `Install-prompt suppression mismatch for ${pathname}${search}`
  );
}

for (const [pathname, search] of [
  ['/account/login', `?next=${encodeURIComponent(FILE_COLLABORATION_PATHS.inbox)}`],
  ['/account/login', `?next=${encodeURIComponent(FILE_COLLABORATION_PATHS.connect)}&next=%2Fhome`],
  ['/account/collaboration/other', ''],
  ['/home', '']
] as const) {
  assert.equal(
    isInstallPromptSuppressedRoute(pathname, search),
    false,
    `Install prompt should remain eligible outside the bounded collaboration suppression: ${pathname}${search}`
  );
}

for (const [permissions, expected] of [
  [{ canDownloadOriginal: false, canComment: false, canApprove: false }, 'Metadata only'],
  [{ canDownloadOriginal: true, canComment: false, canApprove: false }, 'Source download'],
  [{ canDownloadOriginal: false, canComment: true, canApprove: false }, 'Review notes and change requests'],
  [{ canDownloadOriginal: false, canComment: false, canApprove: true }, 'Approval'],
  [
    { canDownloadOriginal: true, canComment: true, canApprove: true },
    'Source download · Review notes and change requests · Approval'
  ]
] as const) {
  assert.equal(describeCollaboratorFilePermissions(permissions), expected);
}

console.log('Sway Collaborator Inbox behavior test passed.');
