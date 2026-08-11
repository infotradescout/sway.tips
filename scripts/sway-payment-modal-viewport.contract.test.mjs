import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const patronView = readFileSync(join(root, 'src/components/PatronView.tsx'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];

const modalStart = patronView.indexOf('/* 4. TEMPORARY CONFIRMATION MODAL OVERLAY */');
const modalEnd = patronView.indexOf('</AnimatePresence>', modalStart);
const modalSource = modalStart >= 0 && modalEnd > modalStart
  ? patronView.slice(modalStart, modalEnd)
  : '';

if (!modalSource) {
  failures.push('PatronView.tsx must retain the payment confirmation modal.');
} else {
  if (!modalSource.includes('items-start')) {
    failures.push('The payment modal overlay must align from the viewport start on constrained screens.');
  }
  if (!modalSource.includes('max-h-[calc(100dvh-2rem)]')) {
    failures.push('The payment dialog must be bounded by the dynamic viewport height.');
  }
  if ((modalSource.match(/overflow-y-auto/g) ?? []).length < 2) {
    failures.push('Both the overlay and payment dialog must allow vertical scrolling.');
  }
  if ((modalSource.match(/overscroll-contain/g) ?? []).length < 2) {
    failures.push('Both payment scroll containers must contain overscroll.');
  }
  if (/max-w-sm[^"\n]*overflow-hidden/.test(modalSource)) {
    failures.push('The payment dialog must not hide overflow and strand authorization controls below the viewport.');
  }
}

if (!(packageJson.scripts?.['test:contracts'] ?? '').includes('node scripts/sway-payment-modal-viewport.contract.test.mjs')) {
  failures.push('test:contracts must include the payment modal viewport contract.');
}

if (failures.length) {
  console.error('Sway payment modal viewport contract failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Sway payment modal viewport contract passed.');
