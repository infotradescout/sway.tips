import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const failures = [];
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8');

function requireIncludes(source, term, label) {
  if (!source.includes(term)) failures.push(`${label} missing term: ${term}`);
}

function requireExcludes(source, term, label) {
  if (source.includes(term)) failures.push(`${label} must exclude term: ${term}`);
}

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}

function requireInsideConditional(source, conditionMarker, contentMarker, label) {
  const content = source.indexOf(contentMarker);
  const condition = content >= 0 ? source.lastIndexOf(conditionMarker, content) : -1;
  const close = content >= 0 ? source.indexOf(') : null}', content) : -1;
  if (content < 0 || condition < 0 || close <= content) {
    failures.push(`${label} must remain inside ${conditionMarker}.`);
  }
}

const requiredFiles = [
  'src/file-collaboration-routing.ts',
  'src/components/FileConnectCard.tsx',
  'src/components/CollaboratorInbox.tsx',
  'scripts/sway-collaborator-inbox.behavior.test.tsx'
];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`Missing Collaborator Inbox proof dependency: ${file}`);
}

const routing = read('src/file-collaboration-routing.ts');
const patronApp = read('src/shells/PatronApp.tsx');
const talentApp = read('src/shells/TalentApp.tsx');
const accountAccess = read('src/components/AccountAccess.tsx');
const fileConnect = read('src/components/FileConnectCard.tsx');
const inbox = read('src/components/CollaboratorInbox.tsx');
const performerFiles = read('src/components/PerformerAudioFiles.tsx');
const server = read('server.ts');
const packageJson = read('package.json');

for (const term of [
  "inbox: '/account/collaboration'",
  "connect: '/account/collaboration/connect'",
  "legacyConnect: '/talent/connect/files'",
  'const FILE_PAIRING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;',
  'const match = /^#token=([A-Za-z0-9_-]{43})$/.exec(hash);',
  'new URLSearchParams({ next: FILE_COLLABORATION_PATHS.connect })',
  'token ? `#token=${token}` : \'\'',
  'if (redirectPath !== FILE_COLLABORATION_PATHS.connect) return redirectPath;',
  'export function resolveLegacyFileConnectTarget(hash: string)'
]) {
  requireIncludes(routing, term, 'File-collaboration routing security contract');
}

const safeAccountNextNormalizer = sourceBetween(
  routing,
  'export function normalizeSafeAccountNextPath',
  'export function readFilePairingTokenFromHash'
);
for (const term of [
  'const isEventPath = new RegExp(`^/e/${UUID_PATTERN}$`, \'i\').test(parsed.pathname);',
  "const isCanonicalEventPath = new RegExp(`^/e/${CANONICAL_UUID_PATTERN}$`, 'i').test(parsed.pathname);",
  "parsed.search === '?buy=1'",
  "parsed.searchParams.getAll('buy').length === 1",
  "parsed.searchParams.get('buy') === '1'",
  "[...parsed.searchParams.keys()].every((key) => key === 'buy')",
  "!raw.includes('#')",
  "if (eventPurchaseIntent) return `${parsed.pathname}?buy=1`;"
]) {
  requireIncludes(safeAccountNextNormalizer, term, 'Canonical event-purchase account-next allowlist');
}

for (const term of [
  "| { name: 'account-collaboration' }",
  "| { name: 'account-collaboration-connect' }",
  "if (pathname === FILE_COLLABORATION_PATHS.connect) return { name: 'account-collaboration-connect' };",
  "if (pathname === FILE_COLLABORATION_PATHS.inbox) return { name: 'account-collaboration' };",
  "if (route.name === 'account-collaboration-connect') return <FileConnectCard />;",
  "if (route.name === 'account-collaboration') return <CollaboratorInbox />;"
]) {
  requireIncludes(patronApp, term, 'Patron shell Collaborator Inbox routes');
}

const accountHome = sourceBetween(accountAccess, 'export function AccountHome()', 'export function AccountRecovery');
if (!accountHome) failures.push('Unable to locate AccountHome for the always-visible Collaborator Inbox entry proof.');
requireIncludes(accountHome, '<a href={FILE_COLLABORATION_PATHS.inbox}', 'Account home Collaborator Inbox entry');
requireIncludes(accountHome, 'Collaborator Inbox</span>', 'Account home Collaborator Inbox entry');
const inboxLinkIndex = accountHome.indexOf('<a href={FILE_COLLABORATION_PATHS.inbox}');
const conditionalRightsIndex = accountHome.indexOf('{(session?.pendingRightsReviewCount ?? 0) > 0 ? (');
const conditionalPerformerIndex = accountHome.indexOf('{session?.performer ? (');
if (inboxLinkIndex < 0 || conditionalRightsIndex < 0 || conditionalPerformerIndex < 0
  || inboxLinkIndex > conditionalRightsIndex || inboxLinkIndex > conditionalPerformerIndex) {
  failures.push('Collaborator Inbox must remain an unconditional account-home entry, outside rights-count and Pro Mode branches.');
}

const legacyConnectBranch = sourceBetween(
  talentApp,
  'if (isTalentFileConnect(pathname))',
  'if (isTalentRightsReview(pathname))'
);
if (!legacyConnectBranch) failures.push('Unable to locate the legacy file-connect redirect branch.');
requireIncludes(talentApp, "return pathname === '/talent/connect/files';", 'Legacy file-connect route matcher');
requireIncludes(
  legacyConnectBranch,
  'window.location.replace(resolveLegacyFileConnectTarget(window.location.hash))',
  'Legacy file-connect canonical replacement'
);
const legacyLoginBranch = sourceBetween(talentApp, 'if (isTalentLogin(pathname))', 'if (isTalentSignup(pathname))');
for (const term of [
  "const targetParams = new URLSearchParams({ intent: 'performer' });",
  "const legacyRedirectValues = sourceParams.getAll('redirect');",
  'normalizeSafeAccountNextPath(',
  "if (safeNext) targetParams.set('next', safeNext);"
]) {
  requireIncludes(legacyLoginBranch, term, 'Legacy performer login parameter allowlist');
}
for (const forbidden of [
  'sourceParams.delete(',
  'sourceParams.set(',
  'sourceParams.toString()'
]) {
  requireExcludes(legacyLoginBranch, forbidden, 'Legacy performer login parameter allowlist');
}

const connectEffect = sourceBetween(fileConnect, 'useEffect(() => {', 'const claim = async () =>');
if (!connectEffect) failures.push('Unable to locate the file-connect session and preview effect.');
const sessionRequestIndex = connectEffect.indexOf("fetch('/api/account/session', { cache: 'no-store' })");
const identityResolutionIndex = connectEffect.indexOf('resolveFileConnectAccountIdentity(sessionData?.account)');
const previewRequestIndex = connectEffect.indexOf("fetch('/api/talent/audio/pairing/preview'");
if (
  sessionRequestIndex < 0
  || identityResolutionIndex <= sessionRequestIndex
  || previewRequestIndex <= identityResolutionIndex
) {
  failures.push('File-connect must resolve and preserve the signed-in account identity before sending the private token to preview.');
}
for (const term of [
  'readFilePairingTokenFromHash(window.location.hash)',
  'const sessionData = await sessionResponse.json().catch(() => ({}));',
  'if (sessionResponse.status === 401)',
  'if (!identity)',
  "setMessage('Unable to confirm which Sway account is signed in.')",
  'setAccountIdentity(identity)',
  "method: 'POST'",
  'body: JSON.stringify({ token: raw })'
]) {
  requireIncludes(connectEffect, term, 'File-connect authenticated preview flow');
}
requireExcludes(connectEffect, 'window.location.search', 'File-connect secret reader');
for (const term of [
  'They are requesting files. Only a performer with Catalog access can select and share a file after pairing.',
  'They intend to share selected files with you after pairing.'
]) {
  requireIncludes(fileConnect, term, 'File-pairing direction-only copy');
}
requireExcludes(
  fileConnect,
  'They want to receive selected files from you.',
  'File-pairing direction-only copy'
);
for (const term of [
  "const [accountIdentity, setAccountIdentity] = useState<FileConnectAccountIdentity | null>(null);",
  "if (!token || !accountIdentity || status === 'claiming') return;",
  "status === 'ready' && preview && accountIdentity",
  'Connecting as <span className="font-black text-white">{accountIdentity.label}</span>',
  '{accountIdentity.email}',
  'Confirm only if this is the account that should claim this one-time QR.'
]) {
  requireIncludes(fileConnect, term, 'File-connect signed-in account confirmation');
}

const accountLogin = sourceBetween(accountAccess, 'export function AccountLogin()', 'export function AccountSignup()');
if (!accountLogin) failures.push('Unable to locate AccountLogin secret continuation flow.');
for (const term of [
  'const nextPath = preserveFileConnectFragment(redirectPath, window.location.hash);',
  'if (fileConnectLogin || nextPath.startsWith(`${FILE_COLLABORATION_PATHS.connect}#token=`))',
  'window.location.replace(nextPath)',
  'window.location.replace(event.currentTarget.href)'
]) {
  requireIncludes(accountLogin, term, 'Account login fragment continuation');
}
if ((accountLogin.match(/onClick=\{replaceFileConnectExit\}/g) ?? []).length !== 3) {
  failures.push('Every recovery, verification, and signup exit from a secret-bearing file login must replace browser history.');
}
for (const term of [
  "const values = params.getAll('next');",
  "if (values.length !== 1) return '';"
]) {
  requireIncludes(accountAccess, term, 'Duplicate account-next rejection');
}
for (const term of [
  'window.location.replace(loginHref)',
  'window.location.replace(FILE_COLLABORATION_PATHS.inbox)',
  'window.location.replace(event.currentTarget.href)'
]) {
  requireIncludes(fileConnect, term, 'Replace-based file-secret navigation');
}
if ((fileConnect.match(/onClick=\{replaceFileConnectExit\}/g) ?? []).length !== 3) {
  failures.push('Every signup or inbox exit from the secret-bearing connect page must replace browser history.');
}

const secretFlowSources = [routing, fileConnect, accountLogin, legacyConnectBranch].join('\n');
for (const forbidden of [
  ".set('token'",
  '.set("token"',
  ".append('token'",
  '.append("token"',
  ".get('token'",
  '.get("token"',
  '?token=',
  '&token=',
  'localStorage',
  'sessionStorage',
  'document.cookie'
]) {
  requireExcludes(secretFlowSources, forbidden, 'Private file token query/storage boundary');
}

for (const term of [
  "import CollaboratorInbox, { type FileConnection } from './CollaboratorInbox';",
  '<CollaboratorInbox',
  'embedded',
  'refreshKey={collaborationRefreshKey}',
  'onConnectionsLoaded={handleConnectionsLoaded}'
]) {
  requireIncludes(performerFiles, term, 'Performer files shared Collaborator Inbox');
}

const tokenRoute = sourceBetween(
  server,
  "app.post('/api/talent/audio/pairing/tokens'",
  "app.post('/api/talent/audio/pairing/preview'"
);
const connectionListRoute = sourceBetween(
  server,
  "app.get('/api/talent/audio/pairing/connections'",
  "app.post('/api/talent/audio/pairing/connections/:connectionId/shares'"
);
const shareRoute = sourceBetween(
  server,
  "app.post('/api/talent/audio/pairing/connections/:connectionId/shares'",
  "app.get('/api/talent/audio/files/shared-with-me'"
);
if (!tokenRoute || !connectionListRoute || !shareRoute) {
  failures.push('Unable to locate all pairing authorization route blocks.');
}
for (const [label, routeSource] of [
  ['Pairing token creation', tokenRoute],
  ['Selected-file sharing', shareRoute]
]) {
  requireIncludes(routeSource, 'accessControl.requireTalentAccess(req)', `${label} authority`);
  requireExcludes(routeSource, 'accessControl.requireAuthenticatedAccountAccess(req)', `${label} authority`);
}
requireIncludes(
  connectionListRoute,
  'accessControl.requireAuthenticatedAccountAccess(req)',
  'Universal connection-list authority'
);
requireIncludes(
  connectionListRoute,
  'listConnections({ userId: accountAccess.actor.actorId })',
  'Universal connection-list account scoping'
);
requireExcludes(connectionListRoute, 'accessControl.requireTalentAccess(req)', 'Universal connection-list authority');

const permissionDescription = sourceBetween(
  inbox,
  'export function describeCollaboratorFilePermissions',
  'function counterpartyLabel'
);
for (const term of [
  "if (file.canDownloadOriginal) permissions.push('Source download')",
  "if (file.canComment) permissions.push('Review notes and change requests')",
  "if (file.canApprove) permissions.push('Approval')",
  "'Metadata only'"
]) {
  requireIncludes(permissionDescription, term, 'Collaborator permission description');
}

const downloadGate = sourceBetween(inbox, '{file.canDownloadOriginal ? (', ') : null}');
requireIncludes(downloadGate, 'Download source file', 'Download permission-gated UI');
requireIncludes(downloadGate, '/download`}', 'Download permission-gated UI');
if ((inbox.match(/\{file\.canComment \? \(/g) ?? []).length < 3) {
  failures.push('Comment permission must gate the review input, note action, and change-request action.');
}
for (const term of ['placeholder="Leave a review note"', 'Add note', 'Request changes']) {
  requireInsideConditional(inbox, '{file.canComment ? (', term, 'Comment permission-gated UI');
}
const approvalGate = sourceBetween(inbox, '{file.canApprove ? (', ') : null}');
requireIncludes(approvalGate, "sendReview(file.grantId, 'approved')", 'Approval permission-gated UI');
requireIncludes(approvalGate, 'Approve', 'Approval permission-gated UI');

for (const term of [
  'import { normalizeSafeAccountNextPath } from "./src/file-collaboration-routing";',
  'const accountNextPath = normalizeSafeAccountNextPath(req.body?.next);',
  "app.post('/api/account/login'"
]) {
  requireIncludes(server, term, 'Server account-next allowlist');
}
for (const [label, source, call] of [
  ['Account access client', accountAccess, 'return normalizeSafeAccountNextPath(values[0], window.location.origin);'],
  ['Legacy performer client', talentApp, 'const safeNext = normalizeSafeAccountNextPath('],
  ['Account auth server', server, 'const accountNextPath = normalizeSafeAccountNextPath(req.body?.next);']
]) {
  requireIncludes(source, call, `${label} shared account-next parity`);
}

requireIncludes(
  packageJson,
  'node scripts/sway-collaborator-inbox.contract.test.mjs',
  'package.json contract gate'
);

const behavior = spawnSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/sway-collaborator-inbox.behavior.test.tsx'],
  { cwd: root, encoding: 'utf8' }
);
if (behavior.status !== 0) {
  failures.push(`Collaborator Inbox behavior proof failed:\n${(behavior.stderr || behavior.stdout).trim()}`);
} else if (behavior.stdout) {
  process.stdout.write(behavior.stdout);
}

if (failures.length) {
  console.error('Sway Collaborator Inbox contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway Collaborator Inbox contract passed.');
