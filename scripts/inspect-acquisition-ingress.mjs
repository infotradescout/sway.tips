import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const ref='e9defcf674e0fbf6ceb89e15ba45899e4d5f9621';
execFileSync('git',['fetch','--no-tags','https://github.com/infotradescout/sway.tips.git',ref],{stdio:'ignore',timeout:60000});
const source=execFileSync('git',['show',ref+':server.ts'],{encoding:'utf8',maxBuffer:8*1024*1024});
const lines=source.split('\n');
for(let i=0;i<lines.length;i++)if(/routeFamilyGuard\(|app\.use\(|express\.json\(|app\.post\("\/api\/analytics\/shell"|registerAffiliateRoutes\(/.test(lines[i])){
 const excerpt=lines.slice(Math.max(0,i-2),Math.min(lines.length,i+5)).map((line,j)=>`${Math.max(0,i-2)+j+1}: ${line}`).join('\n');
 console.log('INGRESS_SOURCE '+JSON.stringify({line:i+1,excerpt}));
}
fs.mkdirSync('.validation-public',{recursive:true});
fs.writeFileSync('.validation-public/index.html','<meta name="robots" content="noindex,nofollow"><h1>Read-only source ordering inspection</h1>');
fs.writeFileSync('.validation-public/robots.txt','User-agent: *\nDisallow: /\n');
