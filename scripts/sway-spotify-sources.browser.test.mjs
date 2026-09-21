// Auth scaffolding retained from the existing Sources journey; actual provider network is intercepted only by a test preload.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startEmbeddedPostgresProof } from './lib/embedded-postgres-proof.ts';

const out = `tmp/music-sources-proof/spotify-${process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL?.trim() ? 'native' : 'embedded'}`;
mkdirSync(out, { recursive: true });
const report = { startedAt: new Date().toISOString(), checks: [], passed: false, providerCalls: 0, productionWrites: false };
const fixtureDirectory = mkdtempSync(join(tmpdir(), 'sway-spotify-flow-'));
const fixtureFile = join(fixtureDirectory, 'provider.json');
const playlistId = '37i9dQZF1DXcBWIGoYBM5M';
const playlistReference = 'https://open.spotify.com/playlist/' + playlistId;
let proof, browser, child, baseUrl, serverTail = '', currentStage = 'initialization';
function configure(config = {}) {
  writeFileSync(fixtureFile+'.new', JSON.stringify({mode:'complete',count:251,revision:'initial',...config}));
  renameSync(fixtureFile+'.new',fixtureFile);
}
function providerRequests() { try { return readFileSync(fixtureFile+'.requests','utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)); } catch { return []; } }
function expectation(source) { return {id:source.id,updatedAt:source.updatedAt}; }
async function sourceFor(context) {
  const result=await api(context,'/api/talent/library/sources');
  return {...result, source:result.sources.find(s=>s.sourceKey==='spotify-'+playlistId)};
}
async function post(context, owner, expected) {
  return context.request.post(baseUrl+'/api/talent/music/spotify/import-playlist',{data:{playlistUrl:playlistReference,performerId:owner,expectedSource:expected}});
}
async function submit(page, {replace=false,consent=true,status=202}={}) {
  currentStage='browser Spotify import';
  const panel=page.locator('[data-sway-source-import-choices]');
  const details=panel.locator('details').filter({has:page.getByLabel('Spotify playlist link',{exact:true})});
  if(await details.getAttribute('open')===null) await details.locator('summary').click();
  await page.getByLabel('Spotify playlist link',{exact:true}).fill(playlistReference);
  if(replace) page.once('dialog',async dialog=>{assert.match(dialog.message(),/^Update /);if(consent) await dialog.accept();else await dialog.dismiss();});
  const pending=consent?page.waitForResponse(r=>r.url().endsWith('/api/talent/music/spotify/import-playlist')&&r.request().method()==='POST'):null;
  await panel.getByRole('button',{name:'Add playlist',exact:true}).click();
  if(!consent){await panel.getByRole('status').filter({hasText:'Import canceled'}).waitFor();return null;}
  const response=await pending; assert.equal(response.status(),status);
  if(status===202) await panel.getByRole('status').filter({hasText:/^Saved /}).waitFor();
  else await panel.getByRole('alert').waitFor();
  return response;
}
const record = name => { report.checks.push(name); console.log('SWAY_SPOTIFY_FLOW_PASS ' + name); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const p = socket.address().port; await new Promise(resolve => socket.close(resolve)); return p;
}
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
async function startServer(listenPort) {
  baseUrl = `http://127.0.0.1:${listenPort}`;
  child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(resolve('scripts/fixtures/spotify-source-provider.mjs')).href, 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'test', PORT: String(listenPort), DATABASE_URL: proof.databaseUrl,
      SWAY_APP_BASE_URL: baseUrl, APP_URL: baseUrl, APP_BASE_URL: baseUrl, VITE_SWAY_DEMO_MODE: 'false',
      SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: 'false', DISABLE_HMR: 'true',
      STRIPE_SECRET_KEY: '', STRIPE_PUBLISHABLE_KEY: '', VITE_STRIPE_PUBLISHABLE_KEY: '', STRIPE_WEBHOOK_SECRET: '',
      SWAY_EMAIL_PROVIDER: '', SWAY_EMAIL_API_KEY: '', SWAY_EMAIL_FROM: '',
      SWAY_SPOTIFY_CLIENT_ID: 'sway-flow-fixture', SWAY_SPOTIFY_CLIENT_SECRET: 'not-a-provider-secret', SWAY_SPOTIFY_FLOW_FIXTURE: fixtureFile },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const consume = data => { serverTail = (serverTail + data.toString()).slice(-12000); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Local Sway server exited before readiness.');
    try { if ((await fetch(baseUrl + '/api/health/network-probe', { signal: AbortSignal.timeout(1000) })).status === 204) return; } catch {}
    await delay(100);
  }
  throw new Error('Local Sway server did not become ready.');
}
async function newAccount(label) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `sources-${suffix}@example.test`, password = `SwaySources!2026-${suffix}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(baseUrl + '/') || /^(data|blob):/.test(url)) return route.continue();
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  currentStage = label + ' signup';
  await page.goto(baseUrl + '/account/signup?intent=performer');
  await page.getByRole('heading', { name: 'Create your Sway account' }).waitFor();
  await page.getByLabel('Your name').fill('Sources ' + label);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByLabel('I accept the Sway Terms.').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  const link = page.getByRole('link', { name: 'Open local verification link' });
  await link.waitFor();
  assert.equal(new URL(await link.getAttribute('href'), baseUrl).origin, new URL(baseUrl).origin);
  await Promise.all([page.waitForURL(url => url.pathname === '/account/login' && url.searchParams.get('verified') === '1'), link.click()]);
  await page.getByLabel('Email').fill(email); await page.getByLabel('Password').fill(password);
  await Promise.all([page.waitForURL(url => url.pathname === '/account'), page.getByRole('button', { name: 'Log in' }).click()]);
  await page.getByRole('heading', { name: 'Activate Pro Mode' }).waitFor();
  await page.getByLabel('Performer name').fill('Sources ' + label);
  await page.getByLabel('Public handle').fill('sources-' + suffix);
  await Promise.all([page.waitForURL(url => url.pathname === '/talent'), page.getByRole('button', { name: 'Activate Pro Mode' }).click()]);
  await page.goto(baseUrl + '/talent/connections');
  await page.locator('[data-sway-source-import-choices]').waitFor();
  return { page, context, errors };
}
async function api(context, path) {
  const response = await context.request.get(baseUrl + path); assert.equal(response.status(), 200); return response.json();
}
async function importFile(page, inputName, fileName, content, { consent = true, replace = false } = {}) {
  currentStage = 'import ' + fileName;
  const confirmation = new Promise((resolve, reject) => page.once('dialog', async dialog => {
    try {
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), replace ? /^Replace the tracks/ : /^Add /);
      if (consent) await dialog.accept(); else await dialog.dismiss();
      resolve();
    } catch (error) { await dialog.dismiss().catch(() => {}); reject(error); }
  }));
  const responsePromise = consent ? page.waitForResponse(response => response.url().endsWith('/api/talent/library/import') && response.request().method() === 'POST') : null;
  const picker=page.locator('[data-sway-file-source-picker]');
  if(await picker.getAttribute('open')===null)await picker.locator(':scope > summary').click();
  const chooserPromise=page.waitForEvent('filechooser');
  await page.getByLabel(inputName,{exact:true}).locator('..').click();
  await (await chooserPromise).setFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from(content) });
  await confirmation;
  let receipt = null;
  if (responsePromise) { const response = await responsePromise; assert.equal(response.status(), 202); receipt = await response.json(); }
  await page.locator('[data-sway-source-import-choices] [role="status"]').filter({ hasText: consent ? /^(Saved|Updated) / : /^Import canceled/ }).waitFor();
  return receipt;
}
async function combinedScreen(page, stage, widths = [1440,390,320]) {
  const workspace=page.locator('[data-sway-performer-connections-workspace]');
  const picker=page.locator('[data-sway-file-source-picker]');
  const playback=page.locator('[data-sway-source-player-setup]');
  for(const width of widths) {
    await page.setViewportSize({width,height:width>1000?1000:844});await page.evaluate(()=>scrollTo(0,0));
    await page.getByText('Sway Performer',{exact:true}).waitFor();
    assert.equal(await page.getByRole('heading',{name:"Tonight's Live Room",exact:true}).count(),0,'Account Sources must not present itself as the live-room screen');
    assert.equal(await page.getByRole('button',{name:'Log out',exact:true}).count(),1);
    const nav=page.getByRole('navigation',{name:'Performer sections'});assert.equal(await nav.getByRole('button').count(),8);
    assert.equal(await nav.getByRole('button',{name:'Sources',exact:true}).getAttribute('aria-current'),'page');
    const saved=await page.locator('[data-sway-linked-sources]').boundingBox();
    const add=await page.locator('[data-sway-source-import-choices]').boundingBox();const player=await playback.boundingBox();
    assert(saved && add && player);
    if(width>=960)assert(player.x>=saved.x+saved.width-1,'Player belongs in the side column');
    else assert(add.y>=saved.y+saved.height-1 && player.y>=add.y+add.height-1,'Mobile order is saved music, imports, playback');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:out+'/combined-'+stage+'-'+width+'.png',fullPage:true});
    if(stage==='empty') {
      if(await picker.getAttribute('open')!==null)await picker.locator(':scope > summary').click();
      await picker.locator(':scope > summary').focus();await page.keyboard.press('Enter');
      assert.notEqual(await picker.getAttribute('open'),null);
      for(const name of ['Apple Music / iTunes','Serato','rekordbox','Traktor','VirtualDJ','Mixxx','Local / USB playlists','Song list / setlist']) {
        const label=page.getByLabel('Import '+name+' file',{exact:true}).locator('..');assert(await label.isVisible());assert((await label.boundingBox()).height>=44);
      }
      await picker.locator(':scope > summary').click();
      await page.locator('[data-sway-spotify-source-picker] > summary').click();
      await page.getByLabel('Spotify playlist link',{exact:true}).waitFor();
      await page.locator('[data-sway-spotify-source-picker] > summary').click();
      assert(await page.getByRole('button',{name:'Set up VirtualDJ connection',exact:true}).isDisabled());
      assert.equal(await workspace.getByRole('link',{name:'Open Live Room',exact:true}).count(),1);
    }
  }
}
async function connectRoomFromSources(a) {
  currentStage='Sources to actual free room and playback preparation';
  let bridgePosts=0,commandPosts=0;
  const observe=r=>{if(r.method()!=='POST')return;if(r.url().endsWith('/api/talent/control-bridge/token'))bridgePosts++;if(r.url().endsWith('/api/talent/playback/commands'))commandPosts++;};
  a.page.on('request',observe);
  const before=JSON.stringify(await sourceFor(a.context));
  await a.page.getByRole('link',{name:'Open Live Room',exact:true}).click();
  const setup=a.page.locator('[data-sway-performer-room-setup]');await setup.waitFor();
  await setup.getByRole('button',{name:/^Free requests/}).click();
  await setup.getByRole('button',{name:'Next',exact:true}).click();
  await setup.getByRole('button',{name:/^Open requests/}).click();
  await setup.getByRole('button',{name:'Next',exact:true}).click();
  await setup.getByText('Free requests and upvotes · money actions off',{exact:true}).waitFor();
  await setup.getByRole('button',{name:'Next',exact:true}).click();
  await setup.getByRole('heading',{name:'Ready to go live'}).waitFor();
  const started=a.page.waitForResponse(r=>r.url().endsWith('/api/session/start')&&r.request().method()==='POST');
  await setup.getByRole('button',{name:'Create room',exact:true}).click();assert((await started).ok());
  const cockpit=a.page.locator('[data-sway-performer-live-cockpit]');await cockpit.waitFor();
  const style=await cockpit.evaluate(el=>{const s=getComputedStyle(el);return {maxWidth:s.maxWidth,padding:s.padding};});
  assert.equal(style.maxWidth,'none','Sources CSS must not constrain the live cockpit');
  await a.page.goto(baseUrl+'/talent/connections');await a.page.locator('[data-sway-source-import-choices]').waitFor();
  const prepare=a.page.getByRole('button',{name:'Set up VirtualDJ connection',exact:true});
  await a.page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Set up VirtualDJ connection'&&!b.disabled));
  await prepare.click();assert.equal(bridgePosts,0);
  await a.page.getByRole('group',{name:'Confirm booth replacement'}).getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(bridgePosts,0);
  await prepare.click();
  const responsePromise=a.page.waitForResponse(r=>r.url().endsWith('/api/talent/control-bridge/token')&&r.request().method()==='POST');
  await a.page.getByRole('button',{name:'Confirm and prepare room file',exact:true}).click();
  const response=await responsePromise;assert.equal(response.status(),200);const receipt=await response.json();
  await a.page.getByText('Room file prepared — player connection is not confirmed yet.',{exact:true}).waitFor();
  assert.equal(bridgePosts,1);
  assert.equal(await a.page.getByLabel('Room for source playback').inputValue(),receipt.gigId);
  const nextDownload=a.page.waitForEvent('download');await a.page.getByRole('button',{name:'Download Windows room file',exact:true}).click();const downloaded=await nextDownload;
  assert.equal(downloaded.suggestedFilename(),receipt.windowsLauncher.filename);
  assert.equal(createHash('sha256').update(readFileSync(await downloaded.path())).digest('hex'),receipt.windowsLauncher.sha256);
  await a.page.getByRole('button',{name:'Open playback controls',exact:true}).click();
  const play=a.page.getByRole('button',{name:'Play deck 1',exact:true});await play.waitFor();assert(await play.isDisabled(),'No device observation means no actionable playback');
  assert.equal(commandPosts,0);assert.equal(JSON.stringify(await sourceFor(a.context)),before);
  await combinedScreen(a.page,'room-prepared',[1440,390,320]);
  a.page.off('request',observe);
  record('Sources opens a real free room, preserves library, confirms one room file, and refuses unobserved playback');
}

try {
  configure();
  proof=await startEmbeddedPostgresProof('spotify_sources_browser'); report.databaseKind=proof.kind;
  const listenPort=await port(); await startServer(listenPort);
  browser=await chromium.launch({headless:true,args:['--disable-dev-shm-usage']});
  const a=await newAccount('Spotify owner');
  await combinedScreen(a.page,'empty');
  record('Combined TalentApp header, keyboard import choices and library-first layouts work at desktop and mobile sizes');
  let postCount=0; a.page.on('request',r=>{if(r.url().endsWith('/api/talent/music/spotify/import-playlist')&&r.method()==='POST')postCount++;});
  await submit(a.page);
  let state=await sourceFor(a.context); const owner=state.performerId;
  assert.equal(state.source.trackCount,251); assert(Number.isFinite(Date.parse(state.source.updatedAt)));
  const library=[];let next='/api/talent/library/tracks';
  do {const result=await api(a.context,next);library.push(...result.external.tracks);const p=result.external.pagination;next=p.hasMore?'/api/talent/library/tracks?'+new URLSearchParams({offset:String(p.nextOffset),version:p.version}):null;}while(next);
  assert.equal(library.length,251);assert.equal(new Set(library.map(t=>t.id)).size,251);
  await Promise.all([a.page.waitForURL(u=>u.pathname==='/talent/music'),a.page.getByRole('navigation',{name:'Performer sections'}).getByRole('button',{name:'Requests',exact:true}).click()]);
  await a.page.getByLabel('Search request library').fill(library.at(-1).title);
  await a.page.getByText(library.at(-1).title,{exact:true}).waitFor();
  await a.page.goto(baseUrl+'/talent/connections');await a.page.locator('[data-sway-source-import-choices]').waitFor();
  record('251-track playlist saves through signed-in React UI, actual HTTP routes and database');
  await importFile(a.page,'Import Song list / setlist file','Other.txt','Another Artist - Preserve this source');
  const other=(await sourceFor(a.context)).sources.find(s=>s.sourceKey!=='spotify-'+playlistId);
  assert(other); const beforeCancel=JSON.stringify(await sourceFor(a.context));const postsBefore=postCount;
  await submit(a.page,{replace:true,consent:false});
  assert.equal(postCount,postsBefore);assert.equal(JSON.stringify(await sourceFor(a.context)),beforeCancel);
  record('Canceled replacement sends no POST and preserves both saved sources');
  configure({mode:'rate_limited'});
  const limited=await submit(a.page,{replace:true,status:429});
  assert.equal(limited.headers()['retry-after'],'7');assert.equal((await limited.json()).providerStatus,'rate_limited');
  await a.page.getByRole('alert').filter({hasText:'Retry after 7 seconds.'}).waitFor();
  assert.equal(JSON.stringify(await sourceFor(a.context)),beforeCancel);
  record('Rate limit displays retry guidance and leaves saved playlist and source version unchanged');
  for(const mode of ['failed_page','changed_snapshot']){
    configure({mode}); await submit(a.page,{replace:true,status:503});
    assert.equal(JSON.stringify(await sourceFor(a.context)),beforeCancel);
  }
  record('Later-page failure and changed provider snapshot cannot partially replace saved tracks');
  configure({count:1001}); await submit(a.page,{replace:true,status:422});
  assert.equal(JSON.stringify(await sourceFor(a.context)),beforeCancel);
  record('Oversized playlist is explicitly rejected, never silently truncated');
  configure({count:3,revision:'replacement'});
  await submit(a.page,{replace:true}); state=await sourceFor(a.context);
  assert.equal(state.source.trackCount,3);assert(Date.parse(state.source.updatedAt)>Date.parse(JSON.parse(beforeCancel).source.updatedAt));
  assert.deepEqual(state.sources.find(s=>s.id===other.id),other);
  record('Confirmed replacement changes only the selected source and advances its version');
  await combinedScreen(a.page,'saved');
  const concurrentExpected=expectation(state.source);
  const concurrent=await Promise.all([post(a.context,owner,concurrentExpected),post(a.context,owner,concurrentExpected)]);
  assert.deepEqual(concurrent.map(r=>r.status()).sort(),[202,409]);
  assert.equal((await sourceFor(a.context)).source.trackCount,3);
  record('Two simultaneous replacements with one observed version yield one success and one conflict');
  // Hold a real Sources GET response while a second writer advances the source.
  state=await sourceFor(a.context);
  let release; const gate=new Promise(resolve=>release=resolve);let seen;const held=new Promise(resolve=>seen=resolve);let intercept=true;
  await a.page.route('**/api/talent/library/sources',async route=>{
    const response=await route.fetch();if(intercept){intercept=false;seen();await gate;}await route.fulfill({response});
  });
  const stale=submit(a.page,{replace:true,status:409});await held;
  assert.equal((await post(a.context,owner,expectation(state.source))).status(),202);
  release();await stale;await a.page.unroute('**/api/talent/library/sources');
  record('A real stale browser preflight cannot overwrite a newer saved playlist');
  const b=await newAccount('Other account');const second=await sourceFor(b.context);const networkBefore=providerRequests().length;
  assert.equal((await post(b.context,owner,null)).status(),409);
  assert.equal(providerRequests().length,networkBefore);
  state=await sourceFor(a.context);
  assert.equal((await post(b.context,second.performerId,expectation(state.source))).status(),409);
  assert.equal((await sourceFor(b.context)).sources.length,0);
  record('Foreign performer and copied source receipts cannot cross account boundaries');
  // The HTTP request starts authorized; its write must recheck changed ownership.
  const ownership=await proof.query('select owner_user_id from performers where id=$1',[owner]);
  const oldOwner=ownership.rows[0].owner_user_id,newOwner=randomUUID();
  await proof.query('insert into users (id,email,display_name) values ($1,$2,$3)',[newOwner,'handoff-'+newOwner+'@example.test','Temporary test owner']);
  configure({count:3,revision:'owner-race',delayMs:600});
  const beforeNetwork=providerRequests().length;const pendingOwnership=post(a.context,owner,expectation(state.source));
  const waitUntil=Date.now()+10000;while(providerRequests().length===beforeNetwork&&Date.now()<waitUntil)await delay(20);
  assert(providerRequests().length>beforeNetwork,'Provider request must begin before changing owner');
  await proof.query('update performers set owner_user_id=$1 where id=$2',[newOwner,owner]);
  try {assert.equal((await pendingOwnership).status(),403);}finally{await proof.query('update performers set owner_user_id=$1 where id=$2',[oldOwner,owner]);}
  assert.equal(JSON.stringify((await sourceFor(a.context)).source),JSON.stringify(state.source));
  record('Ownership changed during provider loading is rejected inside the write transaction');
  configure({count:3,revision:'replacement'});
  // Exercise the real revoke route with a future version, so wall-clock skew is covered.
  await proof.query("update performer_library_sources set updated_at='2099-01-01T00:00:00.000Z' where id=$1",[state.source.id]);
  const future=await sourceFor(a.context);
  const revoked=await a.context.request.post(baseUrl+'/api/talent/library/sources/'+state.source.id+'/revoke');
  assert.equal(revoked.status(),200);const afterRevoke=await sourceFor(a.context);
  assert(Date.parse(afterRevoke.source.updatedAt)>Date.parse(future.source.updatedAt));
  assert.equal((await post(a.context,owner,expectation(future.source))).status(),409);
  record('Revocation advances source version even with clock skew and rejects a stale restore');
  await a.page.goto('about:blank');await b.page.goto('about:blank');await stopServer();await startServer(listenPort);
  await a.page.goto(baseUrl+'/talent/connections');await a.page.locator('[data-sway-source-import-choices]').waitFor();
  assert.deepEqual((await sourceFor(a.context)).source,afterRevoke.source);
  assert.equal((await sourceFor(b.context)).sources.length,0);
  record('Saved source state and account isolation survive process restart');
  await connectRoomFromSources(a);
  for(const width of [1440,390,320]){
    await a.page.setViewportSize({width,height:width===1440?1000:844});
    assert.equal(await a.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await a.page.screenshot({path:out+'/sources-'+width+'.png',fullPage:true});
  }
  assert.deepEqual(a.errors,[]);assert.deepEqual(b.errors,[]);
  record('Desktop and mobile Sources journeys have no page errors or horizontal overflow');
  report.simulatedProviderRequests=providerRequests().length; report.providerCalls=0;report.passed=true;
} catch(error){
  report.error=String(error.stack||error);report.stage=currentStage;console.error('SWAY_SPOTIFY_FLOW_ERROR '+report.error);
  const page=browser?.contexts()[0]?.pages()[0];if(page){report.alerts=await page.locator('[role=alert]').allTextContents().catch(()=>[]);await page.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});}
  console.error(serverTail.split('\n').filter(line=>!line.includes('[SWAY_EMAIL_MOCK]')).join('\n').replace(/postgres(?:ql)?:\/\/[^\s"']+/g,'[OWNED_DATABASE]').slice(-2400));
} finally {
  await browser?.close();await stopServer();await proof?.close();rmSync(fixtureDirectory,{recursive:true,force:true});
  report.finishedAt=new Date().toISOString();writeFileSync(out+'/results.json',JSON.stringify(report,null,2));console.log('SWAY_SPOTIFY_FLOW_SUMMARY '+JSON.stringify(report));
}
if(!report.passed)process.exitCode=1;
