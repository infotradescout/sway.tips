import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const shellFiles = [
  path.join(root, 'src', 'shells', 'PatronApp.tsx'),
  path.join(root, 'src', 'shells', 'TalentApp.tsx')
];

const failures = [];

for (const filePath of shellFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  const fileLabel = path.relative(root, filePath);

  const hasGlobalDemoBanner = /<DemoModeBanner\s*\/>/.test(source);
  if (!hasGlobalDemoBanner) {
    failures.push(`${fileLabel} must retain one full-width demo-mode banner for clear non-production context.`);
  }

  const splitViewStart = source.indexOf('<SplitViewShell');
  const splitViewEnd = splitViewStart === -1 ? -1 : source.indexOf('primary={', splitViewStart);
  const splitViewIntro = splitViewStart === -1 || splitViewEnd === -1
    ? ''
    : source.slice(splitViewStart, splitViewEnd);

  if (splitViewIntro.includes('DemoModeBanner') && splitViewIntro.includes('compact')) {
    failures.push(`${fileLabel} must not add a nested compact demo badge to SplitViewShell chrome.`);
  }
}

if (failures.length > 0) {
  console.error('Mobile demo chrome contract failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Mobile demo chrome contract passed.');
