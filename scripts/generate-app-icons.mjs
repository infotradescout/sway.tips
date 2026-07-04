import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const sourceFile = 'public/assets/sway-s-only-no-text-icon-source.png';
const sourcePath = join(root, sourceFile);
const sourceDataUrl = `data:image/png;base64,${readFileSync(sourcePath).toString('base64')}`;

function iconHtml(size) {
  const innerSize = Math.round(size * 1.08);
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;width:${size}px;height:${size}px;background:#02030a;overflow:hidden;">
    <div style="width:${size}px;height:${size}px;position:relative;background:radial-gradient(circle at 50% 42%, rgba(217,70,239,0.28), transparent 54%), radial-gradient(circle at 50% 76%, rgba(6,182,212,0.22), transparent 42%), #02030a;">
      <img src="${sourceDataUrl}" alt="" style="position:absolute;left:50%;top:50%;width:${innerSize}px;height:${innerSize}px;transform:translate(-50%,-50%);object-fit:cover;object-position:center center;" />
      <div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 52%, transparent 0 46%, rgba(2,3,10,0.28) 72%, rgba(2,3,10,0.74) 100%);"></div>
    </div>
  </body>
</html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();

const targets = [
  { file: 'public/icon-512.png', size: 512 },
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/apple-touch-icon.png', size: 180 },
  { file: 'public/favicon.png', size: 64 }
];

for (const target of targets) {
  await page.setViewportSize({ width: target.size, height: target.size });
  await page.setContent(iconHtml(target.size));
  await page.waitForLoadState('networkidle');
  const buffer = await page.screenshot({ omitBackground: false });
  writeFileSync(join(root, target.file), buffer);
  console.log(`Wrote ${target.file} (${target.size}x${target.size}) from ${sourceFile}`);
}

await browser.close();
