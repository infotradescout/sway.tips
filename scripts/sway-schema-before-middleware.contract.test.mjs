import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const doc = readFileSync(join(root, 'docs/SWAY_STRUCTURAL_OBJECTIONS_RESPONSE.md'), 'utf8');
const server = readFileSync(join(root, 'server.ts'), 'utf8');
const schema = existsSync(join(root, 'src/db/schema.ts')) ? readFileSync(join(root, 'src/db/schema.ts'), 'utf8') : '';
const accessControl = existsSync(join(root, 'src/server/access-control.ts'))
  ? readFileSync(join(root, 'src/server/access-control.ts'), 'utf8')
  : '';
const performerSessionStore = existsSync(join(root, 'src/server/performer-session-store.ts'))
  ? readFileSync(join(root, 'src/server/performer-session-store.ts'), 'utf8')
  : '';

const failures = [];

for (const term of [
  '0A. Repo truth normalization',
  '0B. Hard contract gates',
  'Database schema init',
  'Server route decoupling and separate entrypoints',
  'Middleware guards backed by persisted schema',
  'Move schema initialization before role middleware',
  'PostgreSQL + Drizzle ORM + explicit SQL-friendly schema files'
]) {
  if (!doc.includes(term)) failures.push(`Missing structural build-order term: ${term}`);
}

const schemaExists = existsSync(join(root, 'src/db/schema.ts')) || existsSync(join(root, 'db/schema.sql')) || existsSync(join(root, 'drizzle'));
const middlewareGuardPatterns = [
  /requireRole/i,
  /roleMiddleware/i,
  /authorizeRole/i,
  /app\.use\([^)]*role/i
];

if (!schemaExists) {
  for (const pattern of middlewareGuardPatterns) {
    if (pattern.test(server)) {
      failures.push(`Role middleware appears before persisted schema exists: ${pattern}`);
    }
  }
}

const persistedAuthSchemaTerms = [
  "pgEnum('user_role', ['patron', 'performer', 'admin', 'support'])",
  "export const users = pgTable('users'",
  "role: userRoleEnum('role').notNull().default('patron')",
  "export const performers = pgTable('performers'",
  "ownerUserId: uuid('owner_user_id').notNull().references(() => users.id)",
  "export const performerMemberships = pgTable('performer_memberships'",
  "export const gigAccessGrants = pgTable('gig_access_grants'",
  "export const performerSessions = pgTable('performer_sessions'",
  "tokenHash: text('token_hash').notNull()",
  "revokedAt: timestamp('revoked_at'",
  "tokenHashIdx: uniqueIndex('performer_sessions_token_hash_idx').on(table.tokenHash)"
];

for (const term of persistedAuthSchemaTerms) {
  if (!schema.includes(term)) {
    failures.push(`Persisted auth schema missing required term before middleware gate: ${term}`);
  }
}

const dbBackedGuardTerms = [
  "import { gigAccessGrants, gigSessions, performerMemberships, performers, users } from '../db/schema'",
  'createSwayDb(databaseUrl)',
  'createPerformerSessionStore({ databaseUrl, dbOverride: db })',
  'performerSessionStore?.resolveSessionFromToken(sessionToken)',
  "from(users)",
  "eq(users.role, 'admin')",
  "eq(users.role, 'support')",
  "from(performerMemberships)",
  "from(gigAccessGrants)",
  'async requireTalentAccess(req)',
  'async requireAdminOrSupportAccess(req)',
  'async requireGigMutationAccess(req, gigId)'
];

for (const term of dbBackedGuardTerms) {
  if (!accessControl.includes(term)) {
    failures.push(`Persisted access guard missing DB-backed middleware term: ${term}`);
  }
}

const sessionStoreTerms = [
  "import { performerSessions } from '../db/schema'",
  'readSessionTokenFromRequest(req: Request)',
  'readCookieHeaderValue(req, cookieName) ?? readBearerTokenHeader(req)',
  '.insert(performerSessions)',
  '.from(performerSessions)',
  'eq(performerSessions.tokenHash, tokenHash)',
  'isNull(performerSessions.revokedAt)',
  'gt(performerSessions.expiresAt, now)'
];

for (const term of sessionStoreTerms) {
  if (!performerSessionStore.includes(term)) {
    failures.push(`Performer session store missing durable session term: ${term}`);
  }
}

for (const term of [
  'const accessControl = createAccessControl({',
  'databaseUrl: process.env.DATABASE_URL',
  'routeFamilyGuard(accessControl)(req, res, next)'
]) {
  if (!server.includes(term)) {
    failures.push(`Server missing schema-backed middleware wiring term: ${term}`);
  }
}

if (failures.length) {
  console.error('Schema-before-middleware contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Schema-before-middleware contract passed.');
