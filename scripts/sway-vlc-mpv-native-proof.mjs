// Narrow original-player acceptance on Sway's existing isolated runner.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_VLC_MPV_NATIVE_PROOF, 'true');
const launcher = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(launcher, process.env.SWAY_NATIVE_PLAYER_LAUNCHER);
const candidate = process.env.SWAY_NATIVE_PLAYER_CANDIDATE;
assert.match(candidate || '', /^[0-9a-f]{40}$/);
for (const key of Object.keys(process.env)) {
  if (/DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|AWS|R2).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)/.test(key)) assert(!process.env[key]?.trim(), 'Unexpected credential: ' + key);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sway-vlc-mpv-'));
const checkout = path.join(root, 'source');
const published = path.resolve('.validation-public');
const out = path.join(published, 'native-players', candidate);
fs.mkdirSync(out, { recursive: true });
const report = { candidate, launcher, startedAt: new Date().toISOString(), result: 'fail', steps: [], preserved: [],
  scope: 'Actual Sources native-player React panel, Chromium, local host, stock VLC/mpv executables and read-only independent player observations. Disposable Linux environment, synthetic audio and null audio outputs. Not physical audio, Windows/macOS, full signed-in application, or live production acceptance.',
  newServices: 0, productionChanges: false, physicalAudioAcceptance: false, fullSignedInApplication: false };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const env = Object.fromEntries(['PATH','LANG','LC_ALL','TZ','PLAYWRIGHT_BROWSERS_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
Object.assign(env, { HOME: path.join(root, 'home'), CI: 'true', GIT_TERMINAL_PROMPT: '0', NODE_OPTIONS: '--max-old-space-size=3072',
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright') });
fs.mkdirSync(env.HOME);
async function run(name, command, args, { cwd = root, timeout = 120000 } = {}) {
  console.log('NATIVE_ACCEPTANCE_START ' + name);
  let text = '', timedOut = false;
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore','pipe','pipe'] });
  const consume = bytes => { text += bytes; process.stdout.write(bytes); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
  const result = await new Promise(resolve => { child.once('error', e => resolve({ error: e.message })); child.once('close', (code, signal) => resolve({ code, signal })); });
  clearTimeout(timer);
  fs.writeFileSync(path.join(out, name + '.log'), text);
  const row = { name, ...result, timedOut, passed: result.code === 0 && !result.signal && !result.error && !timedOut, logSha256: sha(text) };
  report.steps.push(row); console.log('NATIVE_ACCEPTANCE_STEP ' + JSON.stringify(row));
  assert(row.passed, name + ' failed'); return text;
}
async function preserve() {
  // Never clear .validation-public. Retain cached files and crawl existing
  // publication references before adding a new, source-namespaced packet.
  const base = 'https://sway-release-proof.onrender.com/';
  const queue = ['index.html','robots.txt','retained-taint.json','source-evidence.json','pr249-supplement.json','mixxx-bootstrap.json',
    'merge/candidate.bundle','merge/merge.json','merge/merge.log','mixxx-native.json'];
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || !/^[A-Za-z0-9_./-]+\.(?:html|txt|json|log|png|wav|bundle)$/.test(name) || name.split('/').includes('..')) continue;
    assert(seen.size < 400, 'Artifact crawl exceeded its bound'); seen.add(name);
    const response = await fetch(base + name, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (response.status === 404 && name !== 'index.html') continue;
    assert(response.ok, 'Cannot preserve previous publication: ' + name);
    const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length < 64 * 1024 * 1024, 'Artifact too large');
    const destination = path.join(published, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
    report.preserved.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
    if (/\.(html|json)$/.test(name)) {
      const text = bytes.toString('utf8');
      for (const match of text.matchAll(/(?:href\s*=\s*["']|"(?:path|artifact|log|receipt)"\s*:\s*")([^"'<>]+\.(?:html|txt|json|log|png|wav|bundle))/g)) {
        const url = new URL(match[1], base + name); if (url.origin === new URL(base).origin) queue.push(decodeURIComponent(url.pathname.slice(1)));
      }
      if (name === 'pr249-supplement.json' || name === 'mixxx-bootstrap.json') {
        const prior = JSON.parse(text);
        for (const row of prior.steps || []) if (/^[a-z0-9-]+$/.test(row.name)) queue.push((name.startsWith('mixxx') ? 'mixxx-' : '') + row.name + '.log');
      }
    }
  }
  assert(report.preserved.some(row => row.path === 'index.html'));
  console.log('NATIVE_PRIOR_PUBLICATION_PRESERVED ' + report.preserved.length);
}
try {
  await preserve();
  await run('clone', 'git', ['clone','--no-hardlinks','--no-checkout',process.cwd(),checkout]);
  await run('fetch', 'git', ['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',candidate], { cwd: checkout });
  await run('checkout', 'git', ['checkout','--detach',candidate], { cwd: checkout });
  assert.equal((await run('source-identity','git',['rev-parse','HEAD'],{cwd:checkout})).trim(),candidate);
  assert.equal((await run('source-clean-before','git',['status','--porcelain'],{cwd:checkout})).trim(),'');
  await run('dependencies','npm',['ci','--include=dev','--no-audit','--no-fund'],{cwd:checkout,timeout:360000});
  assert.match(fs.readFileSync('/etc/os-release','utf8'),/VERSION_CODENAME=bookworm/);
  for (const dir of ['lists/partial','cache/archives/partial','aptlog']) fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(root,'sources.list'),'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian bookworm main\ndeb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian-security bookworm-security main\n');
  env.APT_CONFIG=path.join(root,'apt.conf');
  fs.writeFileSync(env.APT_CONFIG,`Dir::Etc::sourcelist "${root}/sources.list";\nDir::Etc::sourceparts "-";\nDir::Etc::parts "-";\nDir::State::lists "${root}/lists";\nDir::Cache "${root}/cache";\nDir::Log "${root}/aptlog";\nDebug::NoLocking "true";\n`);
  await run('signed-package-index','apt-get',['update'],{timeout:180000});
  const uris=await run('package-uris','apt-get',['--print-uris','--yes','--download-only','--no-install-recommends','install','vlc-bin','vlc-plugin-base','vlc-data','mpv']);
  fs.writeFileSync(path.join(root,'uris.txt'),uris);
  fs.writeFileSync(path.join(root,'download.py'),String.raw`import concurrent.futures,hashlib,json,pathlib,re,subprocess,urllib.request
root=pathlib.Path.cwd(); dest=root/'deps'; dest.mkdir(); packages=root/'packages'; packages.mkdir()
rows=re.findall(r"^'([^']+)' (\S+) (\d+) (\S+)$",(root/'uris.txt').read_text(),re.M)
assert rows,'Missing authenticated package metadata'
def get(row):
 url,name,size,expected=row
 assert url.startswith('https://deb.debian.org/'),url
 data=urllib.request.urlopen(url,timeout=90).read(); assert len(data)==int(size)
 kind,value=expected.split(':',1); kind={'md5sum':'md5'}.get(kind.lower(),kind.lower())
 assert hashlib.new(kind,data).hexdigest()==value
 (packages/name).write_bytes(data)
 return {'file':name,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: result=list(pool.map(get,rows))
for row in result: subprocess.run(['dpkg-deb','-x',str(packages/row['file']),str(dest)],check=True)
(root/'package-receipt.json').write_text(json.dumps(result,indent=2))
print('NATIVE_AUTHENTICATED_PACKAGES '+str(len(result)))
`);
  await run('download-players','python3',[path.join(root,'download.py')],{timeout:360000});
  report.packages=JSON.parse(fs.readFileSync(path.join(root,'package-receipt.json'),'utf8'));
  const deps=path.join(root,'deps');
  Object.assign(env,{PATH:path.join(deps,'usr/bin')+':'+env.PATH,LD_LIBRARY_PATH:[path.join(deps,'usr/lib/x86_64-linux-gnu'),path.join(deps,'lib/x86_64-linux-gnu')].join(':'),VLC_PLUGIN_PATH:path.join(deps,'usr/lib/x86_64-linux-gnu/vlc/plugins'),VLC_DATA_PATH:path.join(deps,'usr/share/vlc')});
  report.vlcVersion=(await run('vlc-version',path.join(deps,'usr/bin/vlc'),['--version'])).split('\n')[0];
  report.mpvVersion=(await run('mpv-version',path.join(deps,'usr/bin/mpv'),['--version'])).split('\n')[0];
  fs.copyFileSync(new URL('./sway-vlc-mpv-native-runtime.mjs',import.meta.url),path.join(root,'native-runtime.mjs'));
  await run('real-player-browser',process.execPath,[path.join(root,'native-runtime.mjs'),checkout,deps,out],{cwd:checkout,timeout:240000});
  report.browser=JSON.parse(fs.readFileSync(path.join(out,'native-player-browser.json'),'utf8'));
  report.players=JSON.parse(fs.readFileSync(path.join(out,'original-player-observations.json'),'utf8'));
  assert.equal(report.browser.passed,true); assert.equal(report.browser.realPlayers,true); assert.equal(report.players.passed,true);
  assert.equal((await run('source-clean-after','git',['diff','--exit-code','HEAD','--'],{cwd:checkout})).trim(),'');
  report.result='pass';
} catch(error) {
  report.error=String(error.stack||error); console.error('NATIVE_ACCEPTANCE_ERROR '+report.error); process.exitCode=1;
  for (const name of ['vlc-player.log','mpv-player.log','native-player-browser.json']) {
    const file=path.join(out,name); if(fs.existsSync(file))console.error('NATIVE_DIAGNOSTIC '+name+' '+fs.readFileSync(file,'utf8').slice(-10000));
  }
}
finally {
  try { fs.rmSync(root,{recursive:true,force:true}); report.ownedWorkspaceRemoved=!fs.existsSync(root); }
  catch(error) { report.cleanupError=String(error); report.result='fail'; process.exitCode=1; }
  report.finishedAt=new Date().toISOString(); fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(report,null,2)+'\n');
  // Keep the old index byte-for-byte; this separate entry points at the new packet.
  fs.writeFileSync(path.join(published,'native-players.html'),'<meta name="robots" content="noindex,nofollow"><h1>Sway VLC/mpv acceptance</h1><a href="native-players/'+candidate+'/receipt.json">Exact source, results and remaining boundaries</a><p><a href="index.html">Earlier publication</a></p>');
  console.log('NATIVE_ACCEPTANCE_SUMMARY '+JSON.stringify(report));
}
