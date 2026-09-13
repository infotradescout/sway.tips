import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The launcher supplies its installed native dependency; this never installs
// packages, starts a cluster, calls providers, or uses an inherited database.
const nativeModule = pathToFileURL(resolve(process.argv[2])).href;
const finalizer = new URL('./lib/source-validation-finalization.mjs', import.meta.url).href;
const temp = mkdtempSync(join(tmpdir(), 'sway-finalization-regression-'));
try {
  // Establish that this is the real upstream failure mechanism, not a mock hook.
  const baseline = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(nativeModule)}); process.exitCode = 1;`], { encoding: 'utf8', timeout: 15000 });
  assert.equal(baseline.error, undefined); assert.equal(baseline.signal, null);
  assert.equal(baseline.status, 0, 'The installed upstream hook must reproduce the swallowed exitCode.');
  for (const scenario of ['success', 'failed-child', 'cleanup-failure', 'copy-failure', 'report-failure', 'index-failure', 'copy-and-cleanup-failure']) {
    const root = join(temp, scenario), repo = join(root, 'repo'), out = join(root, 'out');
    mkdirSync(join(repo, 'tmp', 'music-sources-proof'), { recursive: true }); mkdirSync(out);
    writeFileSync(join(repo, 'tmp', 'music-sources-proof', 'fixture.json'), '{}');
    if (scenario.startsWith('copy-')) writeFileSync(join(out, 'music-sources-proof'), 'Blocks directory copy');
    if (scenario === 'report-failure') mkdirSync(join(out, 'source-evidence.json'));
    if (scenario === 'index-failure') mkdirSync(join(out, 'index.html'));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { finalizeSourceValidation } from ${JSON.stringify(finalizer)};
      const { default: EmbeddedPostgres } = await import(${JSON.stringify(nativeModule)});
      assert(process.listenerCount('beforeExit') > 0);
      const pg = new EmbeddedPostgres({ databaseDir: ${JSON.stringify(join(root, 'unused-database'))}, persistent: false });
      const originalStop = pg.stop.bind(pg);
      pg.stop = async () => {
        await originalStop();
        writeFileSync(${JSON.stringify(join(root, 'cleanup-attempted'))}, 'yes');
        if (${JSON.stringify(scenario)}.includes('cleanup-failure')) throw new Error('Deliberate owned cleanup failure');
      };
      const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(scenario === 'failed-child' ? 'process.exit(7)' : 'process.exit(0)')}]);
      assert.equal(result.error, undefined); assert.equal(result.signal, null);
      const report = { steps: [{ name: 'actual-child', code: result.status, passed: result.status === 0 }], passed: result.status === 0 };
      process.stdout.write('FLUSH_BEGIN ' + 'x'.repeat(256 * 1024) + ' FLUSH_END\\n');
      await finalizeSourceValidation({ report, pg, repo: ${JSON.stringify(repo)}, out: ${JSON.stringify(out)} });
    `], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(child.error, undefined, child.error?.message); assert.equal(child.signal, null);
    assert.equal(child.status, scenario === 'success' ? 0 : 1, scenario + ': ' + child.stderr);
    assert.equal(readFileSync(join(root, 'cleanup-attempted'), 'utf8'), 'yes', scenario);
    assert(child.stdout.includes('FLUSH_BEGIN ' + 'x'.repeat(256 * 1024) + ' FLUSH_END\n'), scenario + ' must flush pending output');
    const summaryLine = child.stdout.split('\n').find(line => line.startsWith('SWAY_SOURCE_SUMMARY '));
    assert(summaryLine, scenario + ' must emit its final decision');
    const report = JSON.parse(summaryLine.slice('SWAY_SOURCE_SUMMARY '.length));
    assert.equal(report.passed, scenario === 'success', scenario);
    if (scenario !== 'report-failure') assert.deepEqual(JSON.parse(readFileSync(join(out, 'source-evidence.json'), 'utf8')), report);
    if (scenario === 'copy-and-cleanup-failure') assert.equal(report.finalizationErrors.length, 2);
    console.log('SWAY_SOURCE_FINALIZATION_PASS ' + scenario);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
