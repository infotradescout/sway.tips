import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import sharp from 'sharp';
import qs from 'qs';
import browserslist from 'browserslist';
import { transform, transformSync } from '@esbuild-kit/core-utils';

const require = createRequire(import.meta.url);
function atLeast(actual, minimum) {
  const value = actual.split('.').map(Number), floor = minimum.split('.').map(Number);
  assert(value.length === 3 && value.every(Number.isInteger), `Invalid dependency version: ${actual}`);
  assert(value[0] > floor[0] || value[0] === floor[0] && (
    value[1] > floor[1] || value[1] === floor[1] && value[2] >= floor[2]
  ), `${actual} is below the security floor ${minimum}`);
}

try {
  // Check the native library actually loaded, not just the JavaScript lock entry.
  atLeast(sharp.versions.sharp, '0.35.4');
  atLeast(sharp.versions.heif, '1.23.2');
  const fixture = sharp({ create: { width: 16, height: 12, channels: 4, background: '#8040ffff' } });
  for (const format of ['png', 'jpeg', 'webp', 'avif']) {
    const encoded = await fixture.clone()[format]().toBuffer();
    const metadata = await sharp(encoded, { failOn: 'error' }).metadata();
    assert.equal(metadata.width, 16);
    assert.equal(metadata.height, 12);
    const resized = await sharp(encoded).resize(8, 6).png().toBuffer();
    const result = await sharp(resized).metadata();
    assert.equal(result.width, 8);
    assert.equal(result.height, 6);
  }
  atLeast(require('qs/package.json').version, '6.16.0');
  assert.deepEqual(qs.parse('filter[name]=stone&filter[state]=active&list[]=a&list[]=b'), {
    filter: { name: 'stone', state: 'active' }, list: ['a', 'b']
  });
  const hostile = qs.parse('a[constructor][isBuffer]=not-a-function', { plainObjects: true });
  assert.doesNotThrow(() => qs.stringify(hostile));

  // Drizzle's legacy loader still uses these two transform APIs. Keep the narrow
  // patched esbuild override compatible without downgrading the migration tool.
  const loaderRequire = createRequire(require.resolve('@esbuild-kit/core-utils'));
  atLeast(loaderRequire('esbuild').version, '0.25.0');
  const source = 'export const answer: number = 42;';
  for (const result of [
    transformSync(source, 'security-fixture.ts', { format: 'cjs' }),
    await transform(source, 'security-fixture.ts', { format: 'cjs' })
  ]) {
    const module = { exports: {} };
    runInNewContext(result.code, { module, exports: module.exports }, { timeout: 1000 });
    assert.equal(module.exports.answer, 42);
  }
  atLeast(require('browserslist/package.json').version, '4.28.7');
  atLeast(JSON.parse(readFileSync(new URL('../node_modules/baseline-browser-mapping/package.json', import.meta.url), 'utf8')).version, '2.11.0');
  assert(browserslist(['> 0.5%', 'not dead']).length > 0);
  console.log('Security dependency compatibility passed: four native image formats, query round trip, TypeScript loader transforms and browser target resolution.');
} catch (error) {
  console.error("Security dependency compatibility failed:", error);
  process.exit(1);
}
