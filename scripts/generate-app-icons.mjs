import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const S_PATH = 'M78 24C78 10 60 2 40 2C18 2 4 14 4 32C4 50 20 58 40 64C60 70 76 78 76 96C76 114 62 126 40 126C20 126 4 118 2 104';

function markSvg(strokeWidth, blur) {
  return `
    <svg viewBox="-20 -20 120 166" width="100%" height="100%" fill="none">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#e879f9" />
          <stop offset="50%" stop-color="#f0abfc" />
          <stop offset="100%" stop-color="#67e8f9" />
        </linearGradient>
        <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="${blur}" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path d="${S_PATH}" stroke="url(#g)" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)" />
    </svg>
  `;
}

function iconHtml(size) {
  const markHeight = Math.round(size * 0.58);
  const markWidth = Math.round(markHeight * (80 / 146));
  const strokeWidth = 14;
  const blur = 4.5;
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;width:${size}px;height:${size}px;background:radial-gradient(circle at 50% 38%, rgba(192,38,211,0.35), transparent 68%), linear-gradient(160deg, #0b0414 0%, #07080c 55%, #04121a 100%);display:flex;align-items:center;justify-content:center;">
    <div style="width:${markWidth}px;height:${markHeight}px;">
      ${markSvg(strokeWidth, blur)}
    </div>
  </body>
</html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();

const targets = [
  { file: 'public/icon-512.png', size: 512 },
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/apple-touch-icon.png', size: 180 }
];

for (const target of targets) {
  await page.setViewportSize({ width: target.size, height: target.size });
  await page.setContent(iconHtml(target.size));
  await page.waitForTimeout(50);
  const buffer = await page.screenshot({ omitBackground: false });
  writeFileSync(join(root, target.file), buffer);
  console.log(`Wrote ${target.file} (${target.size}x${target.size})`);
}

await browser.close();
