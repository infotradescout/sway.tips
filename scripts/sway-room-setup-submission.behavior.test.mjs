import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

// Imported contract runs always read the repository, never an override fixture.
const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const root = direct && process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const setupSource = readFileSync(resolve(root, 'src/components/PerformerRoomSetup.tsx'), 'utf8');
function body(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source boundary: ${start}`);
  return source.slice(from + start.length, to).trim().replace(/;$/, '');
}
const submit = body(setupSource, 'const submit = ', '\n  return (');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error.message) }); }
}
function submitHarness(overrides = {}) {
  const calls = { writes: [], errors: [], pending: [], ids: 0 };
  const context = {
    isStarting: false,
    performerEmailVerified: true,
    performerName: 'A Real Performer',
    talentRole: 'Performer',
    feeType: 'patron',
    minimumTip: 15,
    paymentsEnabled: false,
    searchScope: 'catalog',
    payoutReady: false,
    moneyConfigured: false,
    startPendingRef: { current: false },
    startAttemptRef: { current: null },
    setIsStarting: value => calls.pending.push(value),
    setStartError: value => calls.errors.push(value),
    crypto: { randomUUID: () => `room-${++calls.ids}` },
    onStartSession: data => { calls.writes.push(JSON.parse(JSON.stringify(data))); return Promise.resolve(); },
    ...overrides
  };
  return { run: vm.runInNewContext(`(${submit})`, context), calls, context };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

await test('Verified free setup sends performer-selected values unchanged', async () => {
  const h = submitHarness(); await h.run(); assert.deepEqual(h.calls.writes, [{ talentName:'A Real Performer', talentRole:'Performer', feeType:'patron', minimumTip:15, paymentsEnabled:false, searchScope:'catalog', gig_id:'room-1' }]);
});
await test('Unverified account cannot submit when the disabled button is bypassed', async () => {
  const h = submitHarness({performerEmailVerified:false}); await h.run(); assert.equal(h.calls.writes.length,0); assert.match(h.calls.errors.at(-1), /Verify your email/);
});
for (const name of ['', '   ']) {
  await test(`Blank performer name is rejected (${JSON.stringify(name)})`, async () => {
    const h=submitHarness({performerName:name}); await h.run(); assert.equal(h.calls.writes.length,0); assert.match(h.calls.errors.at(-1), /performer name/);
  });
}
for (const [payoutReady,moneyConfigured] of [[false,false],[false,true],[true,false]]) {
  await test(`Paid setup rejects unavailable readiness ${payoutReady}/${moneyConfigured}`, async () => {
    const h=submitHarness({paymentsEnabled:true,payoutReady,moneyConfigured}); await h.run(); assert.equal(h.calls.writes.length,0); assert.match(h.calls.errors.at(-1), /no longer available/);
  });
}
await test('Confirmed paid eligibility retains requested settings', async () => {
  const h=submitHarness({paymentsEnabled:true,payoutReady:true,moneyConfigured:true}); await h.run(); assert.equal(h.calls.writes.length,1); assert.equal(h.calls.writes[0].paymentsEnabled,true);
});
await test('Free room remains available with money actions unavailable', async () => {
  const h=submitHarness(); await h.run(); assert.equal(h.calls.writes.length,1); assert.equal(h.calls.writes[0].paymentsEnabled,false);
});
await test('Two same-turn submissions invoke creation once', async () => {
  const waiting=deferred(); let count=0;
  const h=submitHarness({onStartSession: () => {count++; return waiting.promise;}});
  const first=h.run(); const second=h.run(); assert.equal(count,1); waiting.resolve(); await Promise.all([first,second]);
});
await test('Rendered busy state blocks submission', async () => {
  const h=submitHarness({isStarting:true}); await h.run(); assert.equal(h.calls.writes.length,0);
});
await test('UUID failure is visible and unlocks the form', async () => {
  const h=submitHarness({crypto:{randomUUID:()=>{throw new Error('No secure room identifier');}}});
  await h.run(); assert.equal(h.calls.writes.length,0); assert.match(h.calls.errors.at(-1), /room could not be created|secure room identifier/); assert.equal(h.calls.pending.at(-1),false); assert.equal(h.context.startPendingRef.current,false);
});
await test('Rejected room creation is visible and unlocks the form', async () => {
  const h=submitHarness({onStartSession:()=>Promise.reject(new Error('Disconnected'))}); await h.run(); assert.ok(h.calls.errors.at(-1)); assert.equal(h.calls.pending.at(-1),false); assert.equal(h.context.startPendingRef.current,false);
});
await test('Unchanged retry reuses its room identifier', async () => {
  const ids=[]; let attempt=0;
  const h=submitHarness({onStartSession:data=>{ids.push(data.gig_id); return ++attempt===1 ? Promise.reject('Network interruption') : Promise.resolve();}});
  await h.run(); await h.run(); assert.deepEqual(ids,['room-1','room-1']); assert.equal(h.calls.ids,1); assert.equal(h.calls.errors.at(-1),null);
});
await test('No automatic retry happens after a rejection', async () => {
  let count=0; const h=submitHarness({onStartSession:()=>{count++;return Promise.reject('Failed');}}); await h.run(); await Promise.resolve(); assert.equal(count,1);
});
await test('Revoked paid eligibility blocks a subsequent retry', async () => {
  let count=0; const h=submitHarness({paymentsEnabled:true,payoutReady:true,moneyConfigured:true,onStartSession:()=>{count++;return Promise.reject('Failed');}});
  await h.run(); h.context.payoutReady=false; await h.run(); assert.equal(count,1); assert.match(h.calls.errors.at(-1), /no longer available/);
});
await test('Revoked email verification blocks a subsequent retry', async () => {
  let count=0; const h=submitHarness({onStartSession:()=>{count++;return Promise.reject('Failed');}});
  await h.run(); h.context.performerEmailVerified=false; await h.run(); assert.equal(count,1);
});
await test('Settings controls cannot change during pending creation', () => {
  assert.ok(setupSource.includes('type="range" disabled={isStarting}'));
  assert.ok(setupSource.includes('type="button" disabled={isStarting} onClick={() => setSearchScope'));
  assert.ok(setupSource.includes('type="button" disabled={isStarting} onClick={() => setStep((current) => Math.min'));
});
await test('Unavailable payments do not advertise available tips', () => {
  assert.ok(setupSource.includes(': payoutReady && moneyConfigured'));
  assert.ok(setupSource.includes('{payoutReady && moneyConfigured ? (paymentMode'));
});

for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': '+result.error : ''}`);
const failed=results.filter(result=>!result.passed).length;
console.log(JSON.stringify({suite:'room-setup-submission',passed:results.length-failed,failed,proof:'extracted actual callbacks with mocked state/network and source wiring; not React, browser, backend, persistence or provider proof'}));
if(failed) process.exitCode=1;
