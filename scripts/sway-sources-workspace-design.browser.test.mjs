import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Expose the real private workspace to this fixture without changing the
// production export graph. State and imports here are synthetic; the normal
// database-backed Sources suite continues to prove persistence separately.
const directory = join('tmp', 'sources-workspace-design-proof');
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'fixture.html'), '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sway Sources component proof</title><body class="bg-slate-950 text-white"><div id="root"></div><script type="module" src="/' + directory + '/fixture.tsx"></script></body></html>');
writeFileSync(join(directory, 'fixture.tsx'), `import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PerformerConnectionsWorkspace,INACTIVE_PERFORMER_NAVIGATION} from '/src/components/TalentDashboard';
import {withSourcePlayerContext} from '/src/components/TalentDashboardWithSources';
import '/src/index.css';
const Scoped = withSourcePlayerContext(function FixtureDashboard(props:any) {
 const [url,setUrl]=useState('');const [populated,setPopulated]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
 const names=['Friday night set','Wedding reception','Acoustic originals','Club favourites','Opening set','Closing set','Audience classics','Late night','Local collection','Summer setlist','Encores','Extended source label that must remain readable even on a narrow display'];
 const sources=populated?names.map((sourceLabel,i)=>({id:'fixture-'+i,sourceLabel,sourceKey:'fixture-'+i,syncKeyPreview:'file-import',connectionStatus:'connected',trackCount:24,lastSyncedAt:'2026-09-16T12:00:00Z'})):[];
 return <><div id="talent_dashboard_panel" className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:py-6">
 <nav data-sway-performer-app-navigation="true" aria-label="Performer sections" className="sticky top-0 z-20 order-1 mx-auto grid w-full max-w-5xl grid-cols-4 gap-1 rounded-2xl border border-white/10 bg-slate-950/95 p-1.5 shadow-2xl backdrop-blur lg:grid-cols-8">{INACTIVE_PERFORMER_NAVIGATION.map(({id,label,icon:Icon}:any)=><button key={id} type="button" aria-current={id==='connections'?'page':undefined} onClick={()=>window.__swayDesign.navigation.push(id)} className="inline-flex min-h-12 flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-[10px] font-black uppercase tracking-wider transition sm:flex-row sm:text-xs"><Icon aria-hidden="true" className="h-4 w-4"/>{label}</button>)}</nav>
 <PerformerConnectionsWorkspace linkedSources={sources} linkedSourcesStatus={error?'error':'ready'} linkedSourcesError={error?'Your music was not removed. Try again.':null} catalogTrackCount={0} externalTrackCount={sources.length*24} requestLibraryStatus="ready" requestLibraryError={null} spotifyPlaylistUrl={url} spotifyImportStatus={busy?'submitting':'idle'} spotifyImportMessage={null} djLibraryImportStatus={busy?'submitting':'idle'} djLibraryImportMessage={null} previewMode={props.previewMode} onSpotifyPlaylistUrlChange={setUrl} onSpotifyPlaylistImport={(e:any)=>{e.preventDefault();window.__swayDesign.actions.push('spotify');}} onDjLibraryFileImport={(e:any)=>window.__swayDesign.actions.push(e.currentTarget.getAttribute('data-sway-source-label'))} onOpenCatalog={()=>window.__swayDesign.actions.push('uploads')} onOpenAdvanced={()=>window.__swayDesign.actions.push('advanced')} onRetry={()=>setError(false)}/>
 </div><footer className="mx-auto flex max-w-6xl flex-wrap gap-4 px-4 py-8 text-sm text-slate-300" aria-label="Synthetic fixture controls"><button onClick={()=>setPopulated(v=>!v)}>Toggle saved fixtures</button><button onClick={()=>setBusy(v=>!v)}>Toggle busy fixture</button><button onClick={()=>setError(v=>!v)}>Toggle error fixture</button></footer></>;
});
function Harness(){const [preview,setPreview]=useState(false);return <main className="mx-auto max-w-7xl px-4 py-4"><Scoped performerProfile={{owner_user_id:'fixture-owner',performer_id:'fixture-performer'}} selectedGigId={null} activeGigId={null} requests={[]} session={{status:'inactive'}} activeRooms={[]} previewMode={preview}/><button className="p-4 text-slate-300" onClick={()=>setPreview(v=>!v)}>Toggle preview fixture</button></main>}
window.__swayDesign={actions:[],navigation:[]};createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness/></React.StrictMode>);`);
let vite, browser;
const results = [];
const sources = ['Apple Music / iTunes','Serato','rekordbox','Traktor','VirtualDJ','Mixxx','Local / USB playlists','Song list / setlist'];
try {
  vite = await createServer({ root: process.cwd(), logLevel: 'error', plugins: [{ name: 'test-only-source-workspace-export', enforce: 'pre', transform(code,id) {
    if (id.split('?')[0].endsWith('/src/components/TalentDashboard.tsx')) return code + '\nexport { PerformerConnectionsWorkspace, INACTIVE_PERFORMER_NAVIGATION };\n';
  } }], server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer.address(); assert(address && typeof address !== 'string');
  const origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440,1024,768,390,320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname)) return route.abort();
      if (url.origin !== origin || url.pathname.startsWith('/api/')) { unexpected.push(url.pathname); return route.abort(); }
      return route.continue();
    });
    const workspace = page.locator('[data-sway-performer-connections-workspace]');
    const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must not overflow');
    try {
      await page.goto(origin + '/' + directory + '/fixture.html');
      await workspace.getByText('No music added yet', { exact: true }).waitFor();
      await noOverflow();
      const navigation = page.getByRole('navigation', { name: 'Performer sections' });
      assert.equal(await navigation.getByRole('button').count(), 8);
      assert.equal(await navigation.getByRole('button', { name: 'Sources', exact: true }).getAttribute('aria-current'), 'page');
      assert((await navigation.boundingBox()).y < (await workspace.boundingBox()).y, 'Navigation stays above the page');
      const saved = await page.locator('[data-sway-linked-sources]').boundingBox();
      const player = await page.locator('[data-sway-source-player-setup]').boundingBox();
      if (width >= 960) assert(player.x >= saved.x + saved.width, 'Player is beside, not above, the library');
      else assert(player.y > saved.y + saved.height, 'Library comes first on mobile');
      await page.locator('#talent_dashboard_panel').screenshot({ path: join(directory, 'empty-' + width + '.png') });
      const picker = page.locator('[data-sway-file-source-picker]');
      assert.equal(await picker.getAttribute('open'), null);
      await picker.locator(':scope > summary').focus();
      await page.keyboard.press('Enter');
      assert.notEqual(await picker.getAttribute('open'), null);
      for (const name of sources) {
        const input = page.getByLabel('Import ' + name + ' file', { exact: true });
        const label = input.locator('..');
        await label.scrollIntoViewIfNeeded();
        assert(await label.isVisible(), name + ' must be reachable');
        assert((await label.boundingBox()).height >= 44);
        const chooser = page.waitForEvent('filechooser');
        await label.click();
        await (await chooser).setFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,Artist\nProof,Fixture\n') });
      }
      assert.deepEqual(await page.evaluate(() => window.__swayDesign.actions), sources);
      await noOverflow();
      await picker.screenshot({ path: join(directory, 'picker-' + width + '.png') });
      await page.getByRole('button', { name: 'Toggle busy fixture', exact: true }).click();
      assert.equal(await page.locator('input[data-sway-source-label]:disabled').count(), 8);
      await page.getByRole('button', { name: 'Toggle busy fixture', exact: true }).click();
      await picker.locator(':scope > summary').click();
      await page.locator('[data-sway-spotify-source-picker] > summary').click();
      await page.getByLabel('Spotify playlist link', { exact: true }).fill('https://open.spotify.com/playlist/synthetic');
      await page.getByRole('button', { name: 'Add playlist', exact: true }).click();
      await page.getByRole('button', { name: /Music uploaded to Sway/ }).click();
      await page.getByRole('button', { name: 'Advanced: reusable booth computer helper', exact: true }).click();
      assert.deepEqual((await page.evaluate(() => window.__swayDesign.actions)).slice(-3), ['spotify','uploads','advanced']);
      await page.locator('[data-sway-spotify-source-picker] > summary').click();
      await page.getByRole('button', { name: 'Toggle saved fixtures', exact: true }).click();
      await workspace.getByText('288 tracks', { exact: true }).waitFor();
      const longLabel = workspace.getByText('Extended source label that must remain readable even on a narrow display', { exact: true });
      assert.equal(await longLabel.evaluate(el => getComputedStyle(el).whiteSpace), 'normal');
      await noOverflow();
      await page.locator('#talent_dashboard_panel').screenshot({ path: join(directory, 'saved-' + width + '.png') });
      await page.getByRole('button', { name: 'Toggle error fixture', exact: true }).click();
      await workspace.getByRole('alert').waitFor();
      assert.equal(await workspace.getByText('No music added yet', { exact: true }).count(), 0);
      await workspace.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.getByRole('button', { name: 'Toggle preview fixture', exact: true }).click();
      assert(await page.getByRole('button', { name: 'Set up VirtualDJ connection', exact: true }).isDisabled());
      assert.equal(await page.locator('input[data-sway-source-label]:disabled').count(), 8);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
      results.push({ width, status: 'PASS', filePickerActions: sources.length, keyboardDisclosure: true, overflow: false });
    } catch (error) {
      results.push({ width, status: 'FAIL', error: String(error), errors, unexpected });
      await page.screenshot({ path: join(directory, 'failure-' + width + '.png'), fullPage: true }).catch(() => {});
    } finally { console.log('SWAY_SOURCE_DESIGN_RESULT', JSON.stringify(results.at(-1))); await context.close(); }
  }
} finally {
  await browser?.close(); await vite?.close();
  rmSync(join(directory,'fixture.html'), { force: true }); rmSync(join(directory,'fixture.tsx'), { force: true });
  writeFileSync(join(directory, 'results.json'), JSON.stringify({ scope: 'Actual Sources components with synthetic state; not signed-in production or physical playback.', cssSha256: createHash('sha256').update(readFileSync('src/performer-workspace.css')).digest('hex'), passed: results.length === 5 && results.every(row => row.status === 'PASS'), results }, null, 2));
}
assert.equal(results.length, 5); assert(results.every(row => row.status === 'PASS'), 'All design journeys must pass');
