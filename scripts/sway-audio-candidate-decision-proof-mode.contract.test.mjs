import assert from 'node:assert/strict';
import { candidateDecisionProofMode } from './lib/candidate-decision-proof-mode.mjs';

// These fixtures exercise selection only: they import no database driver and
// never connect to, reset or hide an inherited database target.
const embeddedArguments = ['--embedded-postgres'];
const realUrl = 'postgresql://proof:private-fixture@127.0.0.1/sway_disposable_test';
assert.equal(candidateDecisionProofMode({ argv: embeddedArguments, env: {} }), 'embedded-postgres');
assert.equal(candidateDecisionProofMode({ argv: [], env: { SWAY_DISPOSABLE_MIGRATION_PROOF: '1' } }), 'embedded-postgres');
for (const env of [
  { DATABASE_URL: realUrl },
  { SWAY_REAL_POSTGRES_PROOF_DATABASE_URL: realUrl },
  { SWAY_REQUIRE_REAL_POSTGRES_PROOF: 'true' },
  { SWAY_REAL_POSTGRES_PROOF_DATABASE_URL: realUrl, SWAY_REQUIRE_REAL_POSTGRES_PROOF: 'true', SWAY_ALLOW_DISPOSABLE_DATABASE_RESET: 'true', SWAY_DISPOSABLE_MIGRATION_PROOF: '1' }
]) {
  assert.throws(() => candidateDecisionProofMode({ argv: embeddedArguments, env }), (error) => {
    assert.match(error.message, /refuses/);
    assert.equal(error.message.includes(realUrl), false);
    return true;
  });
}
assert.throws(() => candidateDecisionProofMode({ argv: ['--embedded-postgres', '--strict-real-postgres'], env: {} }), /refuses/);
assert.throws(() => candidateDecisionProofMode({ argv: ['--unrecognized'], env: {} }), /Unknown/);
assert.throws(() => candidateDecisionProofMode({ argv: [], env: {} }), /requires --embedded-postgres/);

const strictEnvironment = {
  SWAY_DISPOSABLE_MIGRATION_PROOF: '1',
  SWAY_REQUIRE_REAL_POSTGRES_PROOF: 'true',
  SWAY_REAL_POSTGRES_PROOF_DATABASE_URL: realUrl,
  SWAY_ALLOW_DISPOSABLE_DATABASE_RESET: 'true'
};
assert.equal(candidateDecisionProofMode({ argv: [], env: strictEnvironment }), 'real-postgres');
for (const field of Object.keys(strictEnvironment)) {
  const env = { ...strictEnvironment };
  delete env[field];
  assert.throws(() => candidateDecisionProofMode({ argv: [], env }), /requires|required/);
}
assert.throws(() => candidateDecisionProofMode({ argv: [], env: { ...strictEnvironment, DATABASE_URL: realUrl } }), /refuses DATABASE_URL/);
const { SWAY_REQUIRE_REAL_POSTGRES_PROOF: omitted, ...strictFlagEnvironment } = strictEnvironment;
assert.equal(candidateDecisionProofMode({ argv: ['--strict-real-postgres'], env: strictFlagEnvironment }), 'real-postgres');
console.log('Candidate decision fixture intent contract passed: explicit embedded selection, external/strict conflict denial and preserved standalone approval requirements.');
