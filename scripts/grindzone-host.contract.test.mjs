import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('shared phone hosting is optional and cannot replace the main app or migrations',()=>{
 const pkg=JSON.parse(read('package.json')),server=read('server.ts'),prepare=read('scripts/prepare-grindzone-host.mjs');
 assert.equal(pkg.scripts.start,'npm run db:migrate && node dist/server.cjs');
 assert.equal(pkg.scripts.build.split('node scripts/prepare-grindzone-host.mjs').length,2);
 assert.match(server,/process\.env\.GRINDZONE_PHONE_ENABLED === 'true'/);
 assert.match(server,/createHttpServer\(phoneHost \? phoneHost\.wrap\(app\) : app\)/);
 assert.match(server,/phoneHost\?\.attach\(httpServer\)/);
 const pin=prepare.match(/sourceSha='([a-f0-9]{40})'/)?.[1];assert.ok(pin);assert.ok(server.includes(pin));
 assert.match(prepare,/GIT_TERMINAL_PROMPT:'0'/);assert.match(prepare,/--ignore-scripts/);
 assert.match(read('public/sw.js'),/url\.pathname === '\/grindzone' \|\| url\.pathname\.startsWith\('\/grindzone\/'\)/);
});
