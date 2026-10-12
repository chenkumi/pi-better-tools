import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
const root=resolve('plan/review-20261012-evidence/verify-blackhole');
console.log('Progress: building unchanged production sources with only synthetic worker replacements');
const result=await build({entryPoints:[join(root,'probe.ts')],outfile:join(root,'probe.bundle.mjs'),bundle:true,platform:'node',format:'esm',packages:'external',metafile:true,plugins:[{name:'offline-worker',setup(b){b.onResolve({filter:/agents\/observer\/agent\.js$/},()=>({path:'offline-observer',namespace:'synthetic'}));b.onResolve({filter:/agents\/(reflector|dropper)\/agent\.js$/},args=>({path:args.path.includes('reflector')?'offline-reflector':'offline-dropper',namespace:'synthetic'}));b.onLoad({filter:/offline-reflector/,namespace:'synthetic'},()=>({contents:`export async function runReflector() { console.log('Progress: synthetic reflector called'); return {reflections:[]}; }`,loader:'js'}));b.onLoad({filter:/offline-dropper/,namespace:'synthetic'},()=>({contents:`export async function runDropper() { throw Error('Dropper unexpected in bounded fixture'); }`,loader:'js'}));b.onLoad({filter:/offline-observer/,namespace:'synthetic'},()=>({contents:`export async function runObserver(input) { globalThis.__workerCalls=(globalThis.__workerCalls||0)+1; console.log('Progress: synthetic observer called'); return {observations:[{id:'bbbbbbbbbbbb',content:'Independent offline fact',timestamp:'2026-10-12T00:00:00Z',relevance:'high',sourceEntryIds:input.allowedSourceEntryIds,tokenCount:5}]}; }`,loader:'js'}));}}]});
fs.writeFileSync(join(root,'bundle-inputs.json'),JSON.stringify(result.metafile,null,2));
const summary=[];
const selected=process.argv[2];
for(const kind of selected?[selected]:['pending-helper','pending-caller','orphan-helper','orphan-command'])for(const mode of ['control','fault'])for(let repeat=1;repeat<=3;repeat++){
 const label=`${kind}-${mode}-${repeat}`;
 const agent=join(root,'fixtures',label);fs.mkdirSync(agent,{recursive:true});fs.writeFileSync(join(agent,'auth.json'),'{}');
 const env={...process.env,HOME:agent,USERPROFILE:agent,PI_CODING_AGENT_DIR:agent,PI_BLACKHOLE_PASSIVE:'true'};
 for(const k of Object.keys(env))if(/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k))delete env[k];
 console.log(`Progress: running ${label} in fresh process with 60s bound`);
 const args=['--max-old-space-size=256',join(root,'probe.bundle.mjs'),kind,mode];
 const r=spawnSync(process.execPath,args,{env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 fs.writeFileSync(join(root,`${label}.stdout.log`),r.stdout??'');fs.writeFileSync(join(root,`${label}.stderr.log`),r.stderr??'');
 const row={label,command:[process.execPath,...args],exitCode:r.status,signal:r.signal,error:r.error?.message,cleanup:!fs.existsSync(agent)};
 fs.writeFileSync(join(root,`${label}.result.json`),JSON.stringify(row,null,2));summary.push(row);
 console.log(JSON.stringify(row));
 if(fs.existsSync(agent)){fs.rmSync(agent,{recursive:true,force:true});console.log('Progress: runner cleaned failed isolated fixture');}
}
fs.writeFileSync(join(root,selected?`${selected}-summary.json`:'summary.json'),JSON.stringify(summary,null,2));
if(summary.some(s=>s.exitCode!==0))process.exitCode=1;
console.log('Progress: all selected probes finished and evidence persisted');
