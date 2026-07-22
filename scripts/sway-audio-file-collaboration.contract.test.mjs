import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
for (const path of [
  'src/components/PerformerAudioFiles.tsx',
  'src/components/PerformerFilePairing.tsx',
  'src/components/TalentFileConnectCard.tsx',
  'src/server/audio-file-pairing-service.ts',
  'src/server/audio-file-collaboration-service.ts'
]) {
  if (existsSync(join(root, path))) failures.push(`File collaboration UI must remain removed: ${path}`);
}
const server = readFileSync(join(root, 'server.ts'), 'utf8');
if (!server.includes("error: 'This retired product surface is not part of Sway.'")) {
  failures.push('Historical audio/file routes must fail with the explicit product-scope tombstone.');
}
if (failures.length) {
  console.error('Sway retired file-collaboration contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('Sway retired file-collaboration contract passed.');
