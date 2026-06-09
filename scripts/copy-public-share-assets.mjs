import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();
const sourceDir = join(projectRoot, 'public');
const distDir = join(projectRoot, 'dist');

if (!existsSync(sourceDir)) {
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });

for (const entry of readdirSync(sourceDir)) {
  const sourcePath = join(sourceDir, entry);
  const targetPath = join(distDir, entry);
  if (!statSync(sourcePath).isFile()) {
    continue;
  }

  cpSync(sourcePath, targetPath, { force: true });
}
