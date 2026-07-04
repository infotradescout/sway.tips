import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();
const sourceDir = join(projectRoot, 'public');
const distDir = join(projectRoot, 'dist');

if (!existsSync(sourceDir)) {
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });

function copyPublicEntry(sourcePath, targetPath) {
  const stat = statSync(sourcePath);

  if (stat.isDirectory()) {
    mkdirSync(targetPath, { recursive: true });
    for (const entry of readdirSync(sourcePath)) {
      copyPublicEntry(join(sourcePath, entry), join(targetPath, entry));
    }
    return;
  }

  if (!stat.isFile()) {
    return;
  }

  cpSync(sourcePath, targetPath, { force: true });
}

for (const entry of readdirSync(sourceDir)) {
  const sourcePath = join(sourceDir, entry);
  const targetPath = join(distDir, entry);
  copyPublicEntry(sourcePath, targetPath);
}
