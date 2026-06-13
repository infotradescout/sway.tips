import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const splitViewPath = path.join(root, 'src', 'components', 'SplitViewShell.tsx');
const splitViewSource = fs.readFileSync(splitViewPath, 'utf8');

const requiredRules = [
  {
    passes: splitViewSource.includes('aria-label={`${title}: ${primaryLabel}`}'),
    message: 'SplitViewShell must keep panel context available to assistive technology.'
  },
  {
    passes: /className="[^"]*\bsr-only\b[^"]*\blg:not-sr-only\b[^"]*"[\s\S]*\{primaryLabel\}/.test(splitViewSource),
    message: 'Primary panel labels must be hidden visually on mobile and restored on large screens.'
  },
  {
    passes: /className="[^"]*\bsr-only\b[^"]*\blg:not-sr-only\b[^"]*"[\s\S]*\{secondaryLabel\}/.test(splitViewSource),
    message: 'Secondary panel labels must be hidden visually on mobile and restored on large screens.'
  }
];

const failures = requiredRules
  .filter(({ passes }) => !passes)
  .map(({ message }) => message);

if (failures.length > 0) {
  console.error('Mobile SplitView polish contract failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('Mobile SplitView polish contract passed.');
