import { cpSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const scrub = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[OWNED_LOOPBACK_DATABASE]');

// This owns the end of the standalone launcher as well as its imported path.
// embedded-postgres registers a beforeExit hook that calls process.exit(0),
// so setting exitCode alone cannot preserve a failure after cleanup.
export async function finalizeSourceValidation({ report, repo, out, pg }) {
  const fail = (phase, error) => {
    report.passed = false;
    (report.finalizationErrors ??= []).push({ phase, error: scrub(error?.message || error) });
    console.error('SWAY_SOURCE_FINALIZATION_ERROR ' + JSON.stringify(report.finalizationErrors.at(-1)));
  };
  for (const name of ['music-sources-proof', 'public-entry-qa']) {
    try {
      if (existsSync(join(repo, 'tmp', name))) cpSync(join(repo, 'tmp', name), join(out, name), { recursive: true });
    } catch (error) { fail('copy-' + name, error); }
  }
  // Artifact errors must never prevent the owned database cleanup attempt.
  try { await pg?.stop(); } catch (error) { fail('database-cleanup', error); }
  report.finishedAt = new Date().toISOString();
  for (const [name, content] of [
    ['robots.txt', 'User-agent: *\nDisallow: /\n'],
    ['index.html', '<meta name="robots" content="noindex,nofollow"><h1>Sources validation</h1><p>Read the final evidence decision. Owned test application only. Not Sway production or provider integration certification.</p><a href="source-evidence.json">Evidence</a>']
  ]) {
    try { writeFileSync(join(out, name), content); } catch (error) { fail('write-' + name, error); }
  }
  const writeReport = () => {
    try { writeFileSync(join(out, 'source-evidence.json'), JSON.stringify(report, null, 2)); }
    catch (error) { fail('write-source-evidence.json', error); }
  };
  writeReport();
  console.log('SWAY_SOURCE_SUMMARY ' + JSON.stringify({ ...report, steps: report.steps.map(({ tail, ...row }) => row) }));
  // Explicit exit must follow stream callbacks so piped diagnostics are not lost.
  const flushed = await Promise.allSettled([process.stdout, process.stderr].map(stream => new Promise((resolve, reject) => {
    stream.write('', error => error ? reject(error) : resolve());
  })));
  for (const result of flushed) if (result.status === 'rejected') fail('flush-output', result.reason);
  if (flushed.some(result => result.status === 'rejected')) writeReport();
  process.exit(report.passed === true ? 0 : 1);
}
