// Select fixture intent before the helper can select an externally supplied URL.
// The helper retains all disposable-target, hosting and server-attestation guards.
export function candidateDecisionProofMode({ argv = process.argv.slice(2), env = process.env } = {}) {
  const allowedFlags = new Set(['--embedded-postgres', '--strict-real-postgres']);
  if (argv.some((argument) => !allowedFlags.has(argument))) {
    throw new Error('Unknown candidate decision proof argument.');
  }
  const embedded = argv.includes('--embedded-postgres');
  const strict = argv.includes('--strict-real-postgres') || env.SWAY_REQUIRE_REAL_POSTGRES_PROOF === 'true';
  if (env.DATABASE_URL) {
    throw new Error('Candidate decision proof refuses DATABASE_URL.');
  }
  if (embedded) {
    if (strict || env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL) {
      throw new Error('Embedded candidate decision proof refuses real database URLs and strict PostgreSQL selection.');
    }
    return 'embedded-postgres';
  }
  if (env.SWAY_DISPOSABLE_MIGRATION_PROOF !== '1') {
    throw new Error('Candidate decision proof requires --embedded-postgres or SWAY_DISPOSABLE_MIGRATION_PROOF=1.');
  }
  if (env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL
    && (!strict || env.SWAY_ALLOW_DISPOSABLE_DATABASE_RESET !== 'true')) {
    throw new Error('Standalone PostgreSQL requires the strict proof and explicit disposable database reset approval.');
  }
  if (strict && !env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim()) {
    throw new Error('SWAY_REAL_POSTGRES_PROOF_DATABASE_URL is required for the strict candidate decision proof.');
  }
  return strict ? 'real-postgres' : 'embedded-postgres';
}
