import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
assert.equal(process.env.RENDER_SERVICE_ID,'srv-daesln0u01pc73fso5kg');
assert.equal(process.env.SWAY_MIXXX_NATIVE_BOOTSTRAP,'true');
const launcher=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(launcher,process.env.SWAY_VALIDATION_EXPECTED_SHA);
assert.deepEqual(Object.keys(process.env).filter(k=>/DATABASE_URL$|(?:STRIPE|PAYPAL|EMAIL|AWS|R2).*(?:SECRET|TOKEN|API_KEY|ACCESS_KEY)/.test(k)&&process.env[k]?.trim()),[]);
const root=mkdtempSync(join(tmpdir(),'sway-real-mixxx-')),out=resolve('.validation-public');mkdirSync(out,{recursive:true});
const env={PATH:process.env.PATH,HOME:join(root,'home'),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',CI:'true',QT_QPA_PLATFORM:'offscreen',GIT_TERMINAL_PROMPT:'0'};mkdirSync(env.HOME);
const receipt={launcher,startedAt:new Date().toISOString(),status:'preparation',originalPlayerAcceptance:false,paidAccounts:0,productionChanges:false,steps:[]};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function run(name,command,args,{timeout=120000,required=true}={}){let log='';const child=spawn(command,args,{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});const consume=b=>{log+=b;process.stdout.write(b)};child.stdout.on('data',consume);child.stderr.on('data',consume);let timedOut=false;const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL')}catch{}},timeout);const r=await new Promise(done=>{child.on('error',e=>done({code:null,error:e.message}));child.on('close',(code,signal)=>done({code,signal}))});clearTimeout(timer);writeFileSync(join(out,'mixxx-'+name+'.log'),log);receipt.steps.push({name,...r,timedOut,logSha256:sha(log)});console.log('SWAY_MIXXX_STEP '+JSON.stringify(receipt.steps.at(-1)));if(required&&(r.code!==0||timedOut))throw Error(name+' failed');return log;}
try{
 const base='https://sway-release-proof.onrender.com/';
 const paths=['source-evidence.json','pr249-supplement.json','merge/candidate.bundle','merge/merge.json','merge/merge.log'];
 const response=await fetch(base+'pr249-supplement.json',{signal:AbortSignal.timeout(20000)});assert(response.ok);const prior=await response.json();
 for(const row of prior.steps||[])if(/^[a-z0-9-]+$/.test(row.name))paths.push(row.name+'.log');
 receipt.preserved=[];for(const p of new Set(paths)){const r=await fetch(base+p,{signal:AbortSignal.timeout(20000)});assert(r.ok,'Preserve previous artifact '+p);const b=Buffer.from(await r.arrayBuffer());mkdirSync(join(out,p,'..'),{recursive:true});writeFileSync(join(out,p),b);receipt.preserved.push({path:p,sha256:sha(b)});}
 // Native build image has no apt lists. Create signed, task-owned indexes and
 // download/extract packages as an unprivileged user; never apt install the host.
 assert.match(readFileSync('/etc/os-release','utf8'),/VERSION_CODENAME=bookworm/);
 for(const d of ['lists/partial','cache/archives/partial','aptlog'])mkdirSync(join(root,d),{recursive:true});
 writeFileSync(join(root,'sources.list'),'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian bookworm main\ndeb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian-security bookworm-security main\n');
 env.APT_CONFIG=join(root,'apt.conf');writeFileSync(env.APT_CONFIG,`Dir::Etc::sourcelist "${root}/sources.list";\nDir::Etc::sourceparts "-";\nDir::Etc::parts "-";\nDir::State::lists "${root}/lists";\nDir::Cache "${root}/cache";\nDir::Log "${root}/aptlog";\nDebug::NoLocking "true";\n`);
 await run('signed-package-index','apt-get',['update'],{timeout:180000});
 const uris=await run('packages','apt-get',['--print-uris','--yes','--download-only','--no-install-recommends','install','mixxx','libportmidi-dev','jackd2','libjack-jackd2-dev','xvfb','xdotool'],{timeout:120000});
 const py=String.raw`import concurrent.futures,hashlib,json,pathlib,re,subprocess,urllib.request
root=pathlib.Path.cwd(); dest=root/'deps'; dest.mkdir(); packages=root/'packages';packages.mkdir()
rows=re.findall(r"^'([^']+)' (\S+) (\d+) (\S+)$",(root/'uris.txt').read_text(),re.M)
assert rows,'No package download metadata'
def get(row):
 url,name,size,expected=row
 assert url.startswith('https://deb.debian.org/'),(url,'Unexpected repository')
 data=urllib.request.urlopen(url,timeout=90).read();assert len(data)==int(size)
 kind,value=expected.split(':',1);kind={'md5sum':'md5'}.get(kind.lower(),kind.lower());assert hashlib.new(kind,data).hexdigest()==value
 path=packages/name;path.write_bytes(data)
 return {'file':name,'url':url,'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex: result=list(ex.map(get,rows))
for row in result:subprocess.run(['dpkg-deb','-x',str(packages/row['file']),str(dest)],check=True)
(root/'package-receipt.json').write_text(json.dumps(result,indent=2))
print('MIXXX_PACKAGES '+json.dumps(result))
`;
 writeFileSync(join(root,'uris.txt'),uris);writeFileSync(join(root,'download.py'),py);await run('download','python3',[join(root,'download.py')],{timeout:360000});
 const deps=join(root,'deps');env.PATH=join(deps,'usr/bin')+':'+env.PATH;env.LD_LIBRARY_PATH=[join(deps,'usr/lib/x86_64-linux-gnu'),join(deps,'lib/x86_64-linux-gnu')].join(':');env.QT_PLUGIN_PATH=join(deps,'usr/lib/x86_64-linux-gnu/qt5/plugins');
 receipt.packages=JSON.parse(readFileSync(join(root,'package-receipt.json'),'utf8'));
 await run('version',join(deps,'usr/bin/mixxx'),['--version']);
 await run('help',join(deps,'usr/bin/mixxx'),['--help']);
 await run('runtime-details','sh',['-c',`ldd '${deps}/usr/bin/mixxx'; cat '${deps}/usr/include/portmidi.h' | grep -A15 -E 'PmDeviceInfo|Pm_OpenInput|Pm_Read|Pm_Poll|Pm_WriteShort';`]);
 receipt.status='real_binary_prepared_not_playback_acceptance';
 if(process.env.SWAY_MIXXX_EXECUTE_NATIVE==='true'){
   const {runNative}=await import('./sway-mixxx-native-run.mjs');
   await runNative({root,deps,out,env,receipt,run});
 }
}catch(e){receipt.status='preparation_or_acceptance_failed';receipt.error=String(e.stack||e);console.error('SWAY_MIXXX_ERROR '+receipt.error)}
finally{try{rmSync(root,{recursive:true,force:true});receipt.ownedWorkspaceRemoved=true}catch(e){receipt.status='cleanup_failed';receipt.cleanupError=String(e)}}
receipt.finishedAt=new Date().toISOString();writeFileSync(join(out,'mixxx-bootstrap.json'),JSON.stringify(receipt,null,2));writeFileSync(join(out,'index.html'),'<meta name="robots" content="noindex,nofollow"><h1>Sway verification records</h1><p>Read the exact scope; binary preparation alone is not playback acceptance.</p><a href="mixxx-bootstrap.json">Mixxx result</a><p><a href="pr249-supplement.json">Preserved merge and registry receipt</a></p>');console.log('SWAY_MIXXX_BOOTSTRAP '+JSON.stringify(receipt));if(receipt.error||receipt.cleanupError)process.exitCode=1;
