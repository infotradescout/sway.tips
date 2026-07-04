import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const sourceFile = 'public/assets/sway-site-icon-source.png';
const sourcePath = join(root, sourceFile);

if (!existsSync(sourcePath)) {
  console.error(`Missing Sway icon source image: ${sourceFile}`);
  process.exit(1);
}

const sourceDataUrl = `data:image/png;base64,${readFileSync(sourcePath).toString('base64')}`;

function iconHtml(size) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;width:${size}px;height:${size}px;overflow:hidden;background:#020617;">
    <img
      src="${sourceDataUrl}"
      alt=""
      style="width:100%;height:100%;object-fit:cover;object-position:50% 52%;display:block;"
    />
  </body>
</html>`;
}

const targets = [
  { file: 'public/icon-512.png', size: 512 },
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/favicon.png', size: 64 },
  { file: 'public/apple-touch-icon.png', size: 180 }
];

const browser = await chromium.launch();
const page = await browser.newPage();

for (const target of targets) {
  await page.setViewportSize({ width: target.size, height: target.size });
  await page.setContent(iconHtml(target.size), { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const image = document.querySelector('img');
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
  });
  const buffer = await page.screenshot({ omitBackground: false });
  writeFileSync(join(root, target.file), buffer);
  console.log(`Wrote ${target.file} (${target.size}x${target.size}) from ${sourceFile}`);
}

await browser.close();
