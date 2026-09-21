import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, existsSync, cpSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const SOURCE = 'ab21803ee2c735a211411f0e80402cea33b6ad12';
assert.equal(process.env.RENDER_SERVICE_ID, 'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_MULTI_PLAYER_NATIVE, 'true');
const original = process.cwd(), launcher = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
assert.equal(launcher, process.env.SWAY_VALIDATION_EXPECTED_SHA);
assert.deepEqual(Object.keys(process.env).filter(k => /DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|AWS|R2).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)/.test(k) && process.env[k]?.trim()), []);
const root = mkdtempSync(join(tmpdir(), 'sway-multiple-players-')), repo = join(root, 'source'), out = resolve('.validation-public');
mkdirSync(out, { recursive: true });
const env = { PATH: process.env.PATH, HOME: join(root, 'home'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NODE_ENV: 'test', CI: 'true', GIT_TERMINAL_PROMPT: '0' };
mkdirSync(env.HOME);
const report = { source: SOURCE, launcher, startedAt: new Date().toISOString(), passed: false, productionChanges: false, newServices: 0, paidAccounts: 0, unchangedHostedGatesRepeated: false, steps: [], preserved: [], cleanup: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const secret = randomBytes(24).toString('hex'), children = [];
const scrub = text => String(text).split(secret).join('[LOCAL_PLAYER_SECRET]');
const run = async (name, command, args, { cwd = repo, timeout = 120000 } = {}) => {
  let log = '', timedOut = false; const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const consume = data => { const text = scrub(data); log += text; process.stdout.write(text); };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeout);
  const result = await new Promise(done => { child.once('error', error => done({ code: null, error: scrub(error.message) })); child.once('close', (code, signal) => done({ code, signal })); });
  clearTimeout(timer); writeFileSync(join(out, 'multi-player-' + name + '.log'), log);
  const step = { name, ...result, timedOut, logSha256: hash(log) }; report.steps.push(step); console.log('MULTI_PLAYER_STEP ' + JSON.stringify(step));
  assert(result.code === 0 && !result.signal && !timedOut && !result.error, name + ' failed'); return log;
};
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 60000 }).trim();
const start = (name, command, args, extra = {}) => {
  let log = ''; const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const item = { name, child, closed: false }; children.push(item);
  item.done = new Promise(done => { child.once('error', error => { item.error = scrub(error.message); }); child.once('close', (code, signal) => { item.closed = true; item.code = code; item.signal = signal; done(); }); });
  child.stdout.on('data', data => { log += scrub(data); }); child.stderr.on('data', data => { log += scrub(data); }); item.log = () => log; return item;
};
try {
  // Preserve the full earlier artifacts before publishing any new output.
  const base = 'https://sway-release-proof.onrender.com/';
  const paths = new Set(['source-evidence.json', 'pr249-supplement.json', 'merge/candidate.bundle', 'merge/merge.json', 'merge/merge.log',
    'mixxx-bootstrap.json', 'mixxx-native.json', 'mixxx-actual-player-playing.png', 'mixxx-actual-player-paused.png', 'mixxx-actual-desktop-final.png', 'mixxx-sway-playing.png',
    'mixxx-actual-playing.wav', 'mixxx-actual-paused.wav', 'mixxx-playing.f32', 'mixxx-paused.f32', 'mixxx-native-jack.log', 'mixxx-native-mixxx.log']);
  for (const [name, prefix] of [['pr249-supplement.json', ''], ['mixxx-bootstrap.json', 'mixxx-']]) {
    const response = await fetch(base + name, { redirect: 'error', signal: AbortSignal.timeout(20000) }); assert(response.ok);
    const receipt = await response.json();
    for (const step of receipt.steps || []) { assert(/^[a-z0-9-]+$/.test(step.name)); paths.add(prefix + step.name + '.log'); }
  }
  for (const path of paths) {
    const response = await fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(20000) }); assert(response.ok, 'Preserve ' + path);
    const bytes = Buffer.from(await response.arrayBuffer()); mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), bytes);
    report.preserved.push({ path, sha256: hash(bytes) });
  }
  await run('source-init', 'git', ['init', '--quiet', repo], { cwd: root });
  await run('source-fetch', 'git', ['fetch', '--quiet', '--depth=1', 'https://github.com/infotradescout/sway.tips.git', SOURCE]);
  git('checkout', '--quiet', '--detach', 'FETCH_HEAD'); assert.equal(git('rev-parse', 'HEAD'), SOURCE);
  report.tree = git('rev-parse', 'HEAD^{tree}');
  const expected = {
    "scripts/lib/control-bridge-execution.mjs": "147fc46fbb1040cbbafdcac2c97fc3aa68f2041b",
    "scripts/lib/mpv-player-control.mjs": "d15eade68fbfbe5851a03578692a35eee929cf29",
    "scripts/lib/native-player-host.mjs": "78f98a41ea192897b27a5d7d5cee728ca1331ef0",
    "scripts/lib/native-player-hub.mjs": "f8af285728c8c35f2d352407fd9e4f2faa8d15f8",
    "scripts/lib/native-player-registry.mjs": "d57cc957427105f3f5ee5d67c161a7bf5a51cc56",
    "scripts/lib/native-player-session.mjs": "f7b26914841adb4084894b20ef20b38954c89a8f",
    "scripts/lib/native-player-store.mjs": "4a4611353882098b5fc50c76a21fe991b7dfb35d",
    "scripts/lib/player-transport.mjs": "4fb4d1cabc4909bfada3facf72ce527bfa66d7bf",
    "scripts/lib/virtualdj-network-control.mjs": "aca0ff2e28fe8deb9ac9dd5cd536039fb5ac6854",
    "scripts/lib/vlc-player-control.mjs": "128142f41c9f584a850f7e87351120e5ec4b61da",
    "scripts/sway-native-player-adapters.test.mjs": "f5da39ff35704620c75294182e44c11f146dd270",
    "scripts/sway-native-player-host.test.mjs": "8c12b290cc3202aad453a743ae5df4089382d593",
    "scripts/sway-native-player-session.mjs": "d86fa0357351b9a06827ddb4c500912172c294a1",
    "scripts/sway-native-player.browser.test.mjs": "10bcc87a769ca27f5ecffd72e8c41a55656fe0d3",
    "scripts/sway-player-host.mjs": "03ceb9c19e8cb67d3d8230a318f0f4e4081de4f6",
    "src/bounded-player-json.mjs": "b902e4219c43325b69babca314ee7d3f2aa6e93b",
    "src/components/NativePlayerConnections.tsx": "f5b0ccae9137c3bcd55f2d5f8ee03c118dd3d490",
    "src/components/PerformerDirectMusicConnection.tsx": "c11f0cc1f7b1790e3c544deb5a121fe33c633ead",
    "src/native-player-client.d.mts": "4c63572571ef4f2cf002e9f944bc7e0f5d090234",
    "src/native-player-client.mjs": "0c3a33b3001d96b262b57f31f45950196211360b",
    "src/player-connections.mjs": "af6e4c17623d5961275ab36db4cd13eff3edd5fe"
  };
  for (const [file, sha] of Object.entries(expected)) assert.equal(git('rev-parse', 'HEAD:' + file), sha, 'Exact local-to-published source identity: ' + file);
  assert.equal(git('rev-parse', 'HEAD:src/components/PerformerSpotifyConnection.tsx'), '4905ad1dfd9042c12581c549d3840e8111523859');
  report.sourceBlobs = expected;
  const oldLock = JSON.parse(readFileSync(join(original, 'package-lock.json'))), lock = JSON.parse(readFileSync(join(repo, 'package-lock.json')));
  for (const name of ['react', 'react-dom', 'esbuild', 'playwright', 'typescript']) assert.deepEqual(oldLock.packages['node_modules/' + name], lock.packages['node_modules/' + name]);
  symlinkSync(join(original, 'node_modules'), join(repo, 'node_modules'), 'dir');
  await run('scoped-tests', process.execPath, ['--test', 'scripts/sway-native-player-adapters.test.mjs', 'scripts/sway-native-player-host.test.mjs']);
  await run('native-ui-types', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--skipLibCheck', '--jsx', 'react-jsx', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--esModuleInterop', 'src/components/NativePlayerConnections.tsx']);
  await run('browser-fixtures', process.execPath, ['scripts/sway-native-player.browser.test.mjs'], { timeout: 120000 });
  cpSync(join(repo, 'tmp/native-player-browser'), join(out, 'multi-player-fixtures'), { recursive: true });
  assert.match(readFileSync('/etc/os-release', 'utf8'), /VERSION_CODENAME=bookworm/);
  for (const dir of ['lists/partial', 'cache/archives/partial', 'aptlog']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'sources.list'), 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian bookworm main\ndeb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian-security bookworm-security main\n');
  env.APT_CONFIG = join(root, 'apt.conf');
  writeFileSync(env.APT_CONFIG, `Dir::Etc::sourcelist "${root}/sources.list";\nDir::Etc::sourceparts "-";\nDir::Etc::parts "-";\nDir::State::lists "${root}/lists";\nDir::Cache "${root}/cache";\nDir::Log "${root}/aptlog";\nDebug::NoLocking "true";\n`);
  await run('signed-package-index', 'apt-get', ['update'], { cwd: root });
  const uris = await run('packages', 'apt-get', ['--print-uris', '--yes', '--download-only', '--no-install-recommends', 'install', 'vlc-bin', 'vlc-plugin-base', 'vlc-data', 'mpv'], { cwd: root });
  writeFileSync(join(root, 'uris.txt'), uris);
  const python = String.raw`import concurrent.futures,hashlib,json,pathlib,re,subprocess,urllib.request
root=pathlib.Path.cwd();dest=root/'deps';dest.mkdir();packages=root/'packages';packages.mkdir()
rows=re.findall(r"^'([^']+)' (\S+) (\d+) (\S+)$",(root/'uris.txt').read_text(),re.M)
assert rows,'No signed package metadata'
def get(row):
 url,name,size,expected=row
 assert url.startswith('https://deb.debian.org/'),url
 data=urllib.request.urlopen(url,timeout=90).read();assert len(data)==int(size)
 kind,value=expected.split(':',1);kind={'md5sum':'md5'}.get(kind.lower(),kind.lower());assert hashlib.new(kind,data).hexdigest()==value
 (packages/name).write_bytes(data)
 return {'file':name,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: result=list(pool.map(get,rows))
for row in result:subprocess.run(['dpkg-deb','-x',str(packages/row['file']),str(dest)],check=True)
(root/'packages.json').write_text(json.dumps(result,indent=2))
print('MULTI_PLAYER_PACKAGES '+json.dumps(result))
`;
  writeFileSync(join(root, 'download.py'), python); await run('download', 'python3', [join(root, 'download.py')], { cwd: root, timeout: 360000 });
  const deps = join(root, 'deps'); env.PATH = join(deps, 'usr/bin') + ':' + env.PATH;
  env.LD_LIBRARY_PATH = [join(deps, 'usr/lib/x86_64-linux-gnu'), join(deps, 'lib/x86_64-linux-gnu')].join(':');
  env.VLC_PLUGIN_PATH = join(deps, 'usr/lib/x86_64-linux-gnu/vlc/plugins'); env.XDG_DATA_HOME = join(env.HOME, '.local/share');
  const lua = join(env.XDG_DATA_HOME, 'vlc/lua'); mkdirSync(lua, { recursive: true });
  for (const path of ['usr/share/vlc/lua', 'usr/lib/x86_64-linux-gnu/vlc/lua']) if (existsSync(join(deps, path))) cpSync(join(deps, path), lua, { recursive: true });
  report.packages = JSON.parse(readFileSync(join(root, 'packages.json')));
  report.vlcVersion = (await run('vlc-version', join(deps, 'usr/bin/vlc'), ['--version'])).split('\n').slice(0, 3).join('\n');
  report.mpvVersion = (await run('mpv-version', join(deps, 'usr/bin/mpv'), ['--version'])).split('\n').slice(0, 3).join('\n');
  function tone(file, hz) { const frames = 48000 * 90, bytes = Buffer.alloc(44 + frames * 2); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40); for (let i = 0; i < frames; i++) bytes.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * hz * i / 48000)), 44 + 2 * i); writeFileSync(file, bytes); }
  const media = [join(root, 'tone-a.wav'), join(root, 'tone-b.wav')]; tone(media[0], 440); tone(media[1], 660);
  const socketPath = join(root, 'mpv.sock');
  start('vlc', join(deps, 'usr/bin/vlc'), ['--intf=dummy', '--extraintf=http', '--http-host=127.0.0.1', '--http-port=48391', '--http-password=' + secret, '--http-src=' + join(lua, 'http'), '--no-video', '--aout=dummy', '--start-paused', '--no-media-library', '--no-metadata-network-access', ...media]);
  start('mpv', join(deps, 'usr/bin/mpv'), ['--no-config', '--idle=yes', '--pause=yes', '--no-video', '--ao=null', '--input-terminal=no', '--input-ipc-server=' + socketPath, ...media]);
  process.chdir(repo);
  const { VlcPlayerControl } = await import(pathToFileURL(join(repo, 'scripts/lib/vlc-player-control.mjs')));
  const { MpvPlayerControl } = await import(pathToFileURL(join(repo, 'scripts/lib/mpv-player-control.mjs')));
  const vlcConfig = { id: randomUUID(), program: 'vlc', baseUrl: 'http://127.0.0.1:48391', password: secret, timeoutMs: 3000 };
  const mpvConfig = { id: randomUUID(), program: 'mpv', socketPath, timeoutMs: 3000 };
  const vlc = new VlcPlayerControl(vlcConfig), mpv = new MpvPlayerControl(mpvConfig);
  const observations = [];
  const observe = async () => { const [a, b] = await Promise.all([vlc.readState(), mpv.readState()]); const row = { vlc: a, mpv: b }; observations.push(row); return row; };
  const end = Date.now() + 20000; let ready;
  while (Date.now() < end) { if (children.some(c => c.closed)) throw new Error('A stock player exited: ' + JSON.stringify(children.map(c => ({ name: c.name, error: c.error, tail: c.log().slice(-3000) })))); try { ready = await observe(); if (ready.vlc.durationMs > 0 && ready.mpv.durationMs > 0) break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  assert(ready && ready.vlc.durationMs > 0 && ready.mpv.durationMs > 0, 'Both actual players must load media');
  assert.equal(ready.vlc.playing, false); assert.equal(ready.mpv.playing, false);
  let lose = false;
  vlcConfig.fetchImpl = async (url, init) => { const response = await fetch(url, init); if (lose && new URL(url).searchParams.get('command') === 'pl_next') { lose = false; await response.arrayBuffer(); throw new Error('Test-only acknowledgement loss after the real VLC command completed'); } return response; };
  const { exerciseNativePlayerBrowser } = await import(pathToFileURL(join(repo, 'scripts/sway-native-player.browser.test.mjs')));
  report.native = await exerciseNativePlayerBrowser({ configs: [vlcConfig, mpvConfig], out: join(out, 'multi-player-native'), realPlayers: true, loseNextResponse: () => { lose = true; }, observe });
  report.nativeObservations = observations;
  report.audioScope = 'Stock decoders/players with dummy/null output; no physical-speaker claim';
  assert.equal(git('diff', '--name-only', 'HEAD'), ''); report.trackedSourceUnchanged = true; report.passed = true;
} catch (error) { report.error = scrub(error.stack || error); console.error('MULTI_PLAYER_ERROR ' + report.error); }
finally {
  for (const item of children.reverse()) {
    if (!item.closed) try { process.kill(-item.child.pid, 'SIGTERM'); } catch {}
    await Promise.race([item.done, new Promise(r => setTimeout(r, 2500))]);
    if (!item.closed) try { process.kill(-item.child.pid, 'SIGKILL'); } catch {}
    await Promise.race([item.done, new Promise(r => setTimeout(r, 2500))]);
    writeFileSync(join(out, 'multi-player-native-' + item.name + '.log'), item.log());
    report.cleanup.push({ name: item.name, closed: item.closed, code: item.code, signal: item.signal }); if (!item.closed) report.passed = false;
  }
  process.chdir(original); try { rmSync(root, { recursive: true, force: true }); report.workspaceRemoved = true; } catch (error) { report.passed = false; report.cleanupError = String(error); }
  report.finishedAt = new Date().toISOString(); writeFileSync(join(out, 'multi-player-native-validation.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(out, 'index.html'), '<meta name="robots" content="noindex,nofollow"><h1>Sway connection evidence</h1><a href="multi-player-native-validation.json">Multi-program result and limitations</a><p><a href="mixxx-native.json">Preserved Mixxx result</a></p><p><a href="pr249-supplement.json">Preserved registry result</a></p>');
  console.log('MULTI_PLAYER_SUMMARY ' + JSON.stringify({ ...report, nativeObservations: undefined, packages: undefined, preserved: undefined, sourceBlobs: undefined }));
  if (!report.passed) process.exitCode = 1;
}
