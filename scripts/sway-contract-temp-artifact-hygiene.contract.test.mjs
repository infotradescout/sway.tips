import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const tempRoot = join(root, '.tmp');
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py']);
const failures = [];

function findSourceArtifacts(directory) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) return findSourceArtifacts(entryPath);
    if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
      return [relative(root, entryPath).replaceAll('\\', '/')];
    }
    return [];
  });
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const testContracts = packageJson.scripts?.['test:contracts']?.trim() ?? '';
const expectedFinalCommand = 'node scripts/sway-contract-temp-artifact-hygiene.contract.test.mjs';

if (!testContracts.endsWith(expectedFinalCommand)) {
  failures.push('The contract temp-artifact hygiene gate must remain the final test:contracts command.');
}

const sourceArtifacts = findSourceArtifacts(tempRoot);
if (sourceArtifacts.length > 0) {
  failures.push(`Contract execution left source-like artifacts under .tmp: ${sourceArtifacts.join(', ')}`);
}

if (failures.length > 0) {
  console.error('Contract temporary-artifact hygiene failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Contract temporary-artifact hygiene passed.');
