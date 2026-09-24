/** Publish signed GrindZone installers only after the existing full application gates. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function verifyNativePortableMetadata(metadata,sourceRevision){
 if(metadata?.sourceRevision!==sourceRevision||!Array.isArray(metadata.files)||!['desktop/GrindZone.Desktop.exe','desktop/WebView2Loader.dll'].every(name=>metadata.files.some(file=>file.path===name))||typeof metadata.requires!=='string'||!metadata.requires.includes('.NET Framework 4.8')||!metadata.requires.includes('Microsoft Edge WebView2 Runtime'))throw Error('Native GrindZone desktop prerequisites are missing');
 return true;
}
export async function publishManagedGrindZone({target,published,sourceRevision,cleanEnv,verifyLive=false}={}){
 const download=path.join(target,'downloads');
 // Only the signing process receives the dedicated private key. Never pass the host environment to tests.
 if(!fs.existsSync(path.join(download,'managed-release.json'))){
  if(!process.env.GRINDZONE_UPDATE_SIGNING_KEY)throw Error('GrindZone update signing is not configured');
  execFileSync(process.execPath,['tools/build-managed-download.mjs'],{cwd:target,env:{...cleanEnv,GRINDZONE_UPDATE_SIGNING_KEY:process.env.GRINDZONE_UPDATE_SIGNING_KEY},stdio:'inherit',timeout:240000});
 }
 const engine=await import(pathToFileURL(path.join(target,'updates/engine.mjs')).href);
 const trust=JSON.parse(fs.readFileSync(path.join(target,'updates/trust.json'),'utf8'));
 const receipt=JSON.parse(fs.readFileSync(path.join(download,'managed-release.json'),'utf8'));
 const envelope=JSON.parse(fs.readFileSync(path.join(download,'updates/latest.json'),'utf8'));
 const manifest=engine.signedManifest(envelope,trust,{network:true});
 if(receipt.revision!==sourceRevision||manifest.revision!==sourceRevision||receipt.filename!=='GrindZone-Setup-Windows-x64.zip'||receipt.playerDataIncluded!==false||receipt.privateKeyIncluded!==false||receipt.signatureAlgorithm!=='Ed25519')throw Error('Managed release identity or privacy contract failed');
 if(receipt.desktopWindow!=='WebView2 WinForms'||receipt.authenticodeSigned!==false||!['desktop/GrindZone.Desktop.exe','desktop/WebView2Loader.dll'].every(name=>manifest.files.some(file=>file.path===name)))throw Error('Signed GrindZone desktop window is missing');
 const installer=fs.readFileSync(path.join(download,receipt.filename));
 if(installer.length!==receipt.bytes||sha(installer)!==receipt.sha256)throw Error('Managed installer checksum mismatch');
 engine.decodeBundle(fs.readFileSync(path.join(download,'updates',manifest.bundle.name)),manifest);
 fs.mkdirSync(path.join(published,'updates'),{recursive:true});
 for(const name of [receipt.filename,'managed-release.json'])fs.copyFileSync(path.join(download,name),path.join(published,name));
 for(const name of ['latest.json',manifest.bundle.name])fs.copyFileSync(path.join(download,'updates',name),path.join(published,'updates',name));
 const verification={schema:'grindzone.managed-publication.v1',source:sourceRevision,signatureVerified:true,bundleVerified:true,installerVerified:true,physicalWindowsVerified:false,physicalPhoneVerified:false,liveFeedVerified:false};
 if(verifyLive){
  const metadata=await engine.download(trust.updateUrl,{maxBytes:400000,timeoutMs:15000});
  const liveManifest=engine.signedManifest(JSON.parse(metadata.toString('utf8')),trust,{network:true});
  if(liveManifest.revision!==sourceRevision||engine.canonical(liveManifest)!==engine.canonical(manifest))throw Error('Live managed feed does not match this tested release');
  const payload=await engine.download(new URL(liveManifest.bundle.name,trust.updateUrl).href,{maxBytes:liveManifest.bundle.bytes});
  engine.decodeBundle(payload,liveManifest);
  const setup=await engine.download(new URL('../'+receipt.filename,trust.updateUrl).href,{maxBytes:receipt.bytes});
  if(setup.length!==receipt.bytes||sha(setup)!==receipt.sha256)throw Error('Live installer integrity failed');
  verification.liveFeedVerified=true;verification.liveInstallerVerified=true;verification.checkedAt=new Date().toISOString();
 }
 fs.writeFileSync(path.join(published,'managed-verification.json'),JSON.stringify(verification,null,2)+'\n');
 fs.writeFileSync(path.join(published,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>GrindZone — Install once</title><style>body{margin:0;padding:28px;background:#101711;color:#eef0e9;font:18px/1.6 system-ui}main{max-width:740px;margin:5vh auto}h1{font-size:42px;line-height:1.1}a{color:#ffae65}.download{display:inline-block;padding:14px 22px;background:#ec8c39;color:#111;border-radius:8px;font-weight:700;text-decoration:none}small{display:block;overflow-wrap:anywhere;color:#b8c1b5}.note{border-left:3px solid #ec8c39;padding-left:18px;margin-top:26px}</style><main><small>WINDOWS X64 — MANAGED PREVIEW</small><h1>GrindZone</h1><p>Install once. Future verified updates download automatically and activate the next time you open GrindZone.</p><a class="download" href="${receipt.filename}?v=${sourceRevision}" download>Download the install-once package</a><h2>One-time setup</h2><p>Close any older running GrindZone app. Extract this whole package and open <strong>INSTALL.cmd</strong>. Then use the <strong>GrindZone desktop shortcut</strong> instead of an older extracted folder. The Node runtime is included. The desktop window requires .NET Framework 4.8 and Microsoft Edge WebView2 Runtime on Windows. No browser extension or remote-control app is needed.</p><div class="note"><strong>Your journal and phone pairing stay in their current data directory.</strong><p>Game saves remain read-only. Updates never restart an active hunt. Failed startup restores the previous compatible app; a pre-activation journal backup protects recovery. After activation, later player entries are never rewound.</p></div><p><strong>Settings → App updates</strong> shows the installed build, any ready update and a manual check button. Offline launches retain the installed signed app. Updates that change the journal storage contract are withheld until a compatible migration is provided.</p><p>Downloads and update payloads are verified using pinned Ed25519 signatures and checksums. This is <strong>not a Windows Authenticode-signed executable installer</strong>; Windows may show an unknown-publisher warning. Do not disable Windows security settings.</p><p>Without a PC? <a href="/grindzone/play/">Open the browser journal and maps</a>. Browser-only progress is not account sync.</p><p><a href="managed-release.json">Installer details</a> · <a href="managed-verification.json">Signed publication verification</a> · <a href="updates/latest.json">Signed update feed</a> · <a href="local-herds.json">Herd and trophy checks</a> · <a href="local-phone.json">Phone checks</a> · <a href="GrindZone-Windows-x64.zip">Portable package without managed setup</a></p><small>Source ${sourceRevision}<br>Installer SHA-256 ${receipt.sha256}<br>Automated hosted checks use synthetic records. Owner-PC installation and physical-phone acceptance are separate and are not asserted here.</small></main></html>`);
 console.log('GRINDZONE_MANAGED_PUBLICATION '+JSON.stringify({...verification,...receipt}));
 return verification;
}
