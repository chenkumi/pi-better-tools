import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve('.'), dir=resolve('plan/review-20261012-evidence/verify-pty-web/v3');
const baseline=new Map(readFileSync('plan/review-20261012-evidence/source-sha256.txt','utf8').trim().split(/\r?\n/).map(l=>{const m=l.match(/^([A-Fa-f0-9]{64})\s+(.+)$/);assert.ok(m);return [m[2].replaceAll('\\','/'),m[1].toLowerCase()];}));
function walk(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(p,e.name)):[join(p,e.name)]);}
const files=['modules/pty-terminal/README.md','modules/web-tools/README.md',...walk('modules/pty-terminal/src'),...walk('modules/web-tools/src')].map(p=>p.replaceAll('\\','/'));
async function hashes(phase){const rows=files.map(path=>{const actual=createHash('sha256').update(readFileSync(path)).digest('hex');return {path,expected:baseline.get(path),actual,match:baseline.get(path)===actual};});await writeFile(join(dir,`hash-${phase}.json`),JSON.stringify(rows,null,2));assert.ok(rows.every(r=>r.match),'Baseline mismatch');console.log(`Full SHA256 baseline check ${phase}: ${rows.length} files match`);}
await hashes('before');
const dependency=['node_modules/node-pty/package.json','node_modules/node-pty/lib/unixTerminal.js','node_modules/node-pty/lib/terminal.js','node_modules/node-pty/lib/windowsTerminal.js'];
await writeFile(join(dir,'environment.json'),JSON.stringify({date:new Date().toISOString(),node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch,gitPresent:existsSync('.git'),dependency:dependency.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex')}))},null,2));
const records=[];
async function child(name,exe,args,env,cwd){
 console.log(`Starting isolated process: ${name}`);
 return new Promise((resolveRun,reject)=>{
  let stdout='',stderr='',hardStopped=false;
  const proc=spawn(exe,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  const progress=setInterval(()=>console.log(`Verification in progress: ${name}`),2000);
  const limit=setTimeout(()=>{hardStopped=true;console.log(`External 15s safety stop: ${name}`);proc.kill('SIGKILL');},15000);
  proc.stdout.on('data',d=>{stdout+=d;process.stdout.write(d);});proc.stderr.on('data',d=>{stderr+=d;process.stderr.write(d);});
  proc.once('error',e=>{clearInterval(progress);clearTimeout(limit);reject(e);});
  proc.once('close',async(code,signal)=>{clearInterval(progress);clearTimeout(limit);const rec={name,command:[exe,...args],cwd,code,signal,hardStopped,pid:proc.pid};await writeFile(join(dir,`${name}.stdout.log`),stdout);await writeFile(join(dir,`${name}.stderr.log`),stderr);records.push(rec);await writeFile(join(dir,'exits.json'),JSON.stringify(records,null,2));console.log(JSON.stringify({phase:'child-close',...rec}));resolveRun(rec);});
 });
}
// WSL availability only; no installation, login or remote command.
const wsl=join(process.env.SystemRoot??'C:/Windows','System32','wsl.exe');
if(existsSync(wsl))await child('wsl-availability',wsl,['--list','--quiet'],process.env,root);else await writeFile(join(dir,'wsl-availability.stdout.log'),'wsl.exe unavailable; POSIX native validation not executed\n');
if(existsSync(wsl))await child('wsl-node-preflight',wsl,['--distribution','Ubuntu','--exec','/usr/bin/env','-i','PATH=/usr/bin:/bin','HOME=/nonexistent','PI_BLACKHOLE_PASSIVE=true','/bin/sh','-c','command -v node; node --version'],{},root);
for(const group of ['web']){
 console.log(`Starting verification group: ${group}`);
 for(let round=2;round<=3;round++){
  const cases=group==='input'?[['blocked','0'],['drain','0']]:group==='wait'?[['within','0'],['prefix','0'],['suffix','0']]:[32768,65536,131072].flatMap(n=>[['control',String(n)],['angles',String(n)]]);
  for(const [kind,n]of cases){
   const name=`${group}-${kind}-${n}-r${round}`,home=join(dir,`fixture-${name}`);await mkdir(join(home,'agent'),{recursive:true});
   const env={};for(const [k,v]of Object.entries(process.env))if(/^(path|systemroot|windir|comspec|pathext)$/i.test(k))env[k]=v;
   Object.assign(env,{HOME:home,USERPROFILE:home,APPDATA:home,LOCALAPPDATA:home,TMP:home,TEMP:home,TMPDIR:home,PI_CODING_AGENT_DIR:join(home,'agent'),PI_AGENT_DIR:join(home,'agent'),PI_WEB_TOOLS_CONFIG:join(home,'missing-config.json'),PI_OFFLINE:'1',PI_BLACKHOLE_PASSIVE:'true'});
   try{const rec=await child(name,process.execPath,['--max-old-space-size=256','--import',pathToFileURL(join(root,'node_modules/tsx/dist/loader.mjs')).href,resolve('plan/review-20261012-evidence/verify-pty-web/probe.mjs'),group,kind,n],env,root);if(rec.hardStopped){assert.equal(group,"web");assert.equal(kind,"angles");assert.equal(n,"131072");assert.equal(rec.signal,"SIGKILL");console.log("Censored observation preserved; child close confirmed");}else{assert.equal(rec.code,0,`Child failed: ${name}`);}}finally{await rm(home,{recursive:true,force:true});assert.equal(existsSync(home),false);console.log(`Isolated fixture cleanup complete: ${name}`);}
  }
 }
 await hashes(`after-${group}`);
 await writeFile(join(dir,`status-${group}.json`),JSON.stringify({state:'completed',rounds:[2,3],children:records.filter(r=>r.name.startsWith(group+'-')).length,allExitZero:records.filter(r=>r.name.startsWith(group+'-')).every(r=>r.code===0),fixturesRemoved:true},null,2));
}
await hashes('final');console.log('Remaining Web rounds completed; censored observations are not passes; child close confirmed and fixtures removed');
