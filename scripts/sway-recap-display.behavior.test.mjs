import assert from 'node:assert/strict';
import { formatRecapMoney, isRecapMoney, recapMoneyState, buildRecapShareText } from '../src/recap-display.ts';
let count = 0;
function check(name, run) { run(); count++; console.log(`PASS ${name}`); }
for (const [value, expected] of [[0, '$0.00'], [1.25, '$1.25'], [12.34, '$12.34'], [1234567.89, '$1,234,567.89']]) {
  check(`saved dollar amount ${value} is formatted once`, () => assert.equal(formatRecapMoney(value), expected));
}
for (const value of [null, undefined, '12.34', NaN, Infinity, -Infinity, -1, {}, []]) {
  check(`invalid amount ${String(value)} is never fabricated as zero or shared`, () => {
    assert.equal(isRecapMoney(value), false);
    assert.equal(formatRecapMoney(value), 'Unavailable');
    assert.equal(buildRecapShareText(value), null);
    assert.equal(recapMoneyState('live', 'platform_balance', value).canShare, false);
  });
}
for (const environment of ['test', 'live', 'unavailable', undefined]) {
  for (const settlement of ['platform_test_balance', 'platform_balance', 'connected_account', 'unavailable', 'mixed', undefined]) {
    check(`sharing boundary ${environment}/${settlement}`, () => {
      const actual = recapMoneyState(environment, settlement, 12.34);
      const expectedTest = environment === 'test' || settlement === 'platform_test_balance';
      const expectedLive = !expectedTest && environment === 'live' && ['platform_balance', 'connected_account'].includes(settlement);
      assert.equal(actual.test, expectedTest);
      assert.equal(actual.live, expectedLive);
      assert.equal(actual.canShare, expectedLive);
      if (actual.test) assert.equal(actual.label, 'Test payment volume');
    });
  }
}
check('recap text describes captured volume, not earnings or a confirmed cash-out', () => {
  assert.equal(buildRecapShareText(12.34), 'I just wrapped a Sway night with $12.34 in captured room payments. Final settlement can change after refunds or disputes. www.sway.tips');
});
console.log(`RECAP_DISPLAY_TOTAL ${count} PASS ${count} FAIL 0`);
