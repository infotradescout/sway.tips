import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();
const sourceDir = join(projectRoot, 'public');
const distDir = join(projectRoot, 'dist');

if (!existsSync(sourceDir)) {
  process.exit(0);
}

function copyEntries(source, target) {
  mkdirSync(target, { recursive: true });

  for (const entry of readdirSync(source)) {
    const sourcePath = join(source, entry);
    const targetPath = join(target, entry);
    const stats = statSync(sourcePath);

    if (stats.isDirectory()) {
      copyEntries(sourcePath, targetPath);
      continue;
    }

    if (stats.isFile()) {
      cpSync(sourcePath, targetPath, { force: true });
    }
  }
}

copyEntries(sourceDir, distDir);
