import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.on('uncaughtException', (error) => {
  console.error(error);
  process.exit(1);
});

const script = readFileSync(new URL('./sway-native-ticket-production-proof.mjs', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.equal(
  packageJson.scripts['proof:tickets:production'],
  'node scripts/sway-native-ticket-production-proof.mjs'
);
for (const required of [
  'stripe_mode_matches',
  'payment_intent_matches_order',
  'captured_total_matches',
  'processor_fee_matches',
  'ticket_issued_for_paid_order',
  'admission_state_coherent',
  'terminal_operation_not_failed',
  'processor_events_settled',
  'expected_lifecycle_outcome',
  'double_entry_ledger_balances',
  "decision: checks.every((item) => item.status === 'pass') ? 'GO' : 'HOLD'",
  'process.exitCode = 1'
]) {
  assert.ok(script.includes(required), `Missing fail-closed proof boundary: ${required}`);
}

console.log('Native ticket production proof contract passed.');
