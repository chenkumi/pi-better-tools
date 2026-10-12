import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const dir=resolve('plan/review-20261012-evidence/verify-schedule-schema');
const output=[];const log=x=>{const s=typeof x==='string'?x:JSON.stringify(x);output.push(s);console.log(s);};
log('Progress: auditing stored logs and cleanup');
const summary=JSON.parse(fs.readFileSync(join(dir,'summary.json'),'utf8'));assert.equal(summary.failures,0);
const cost=new Map(),pids=new Set();
for(const mode of ['schedule','schema'])for(const run of [1,2,3]){
 const text=fs.readFileSync(join(dir,`${mode}-${run}.log`),'utf8');assert.match(text,/exit=0\nsignal=null\nerror=\n$/);assert.match(text,/--- STDERR ---\n\n--- END ---/);
 const pid=Number(text.match(/pid=(\d+)/)[1]);assert.ok(!pids.has(pid));pids.add(pid);
 for(const line of text.split('\n'))if(line.startsWith('{"kind"')){
  const item=JSON.parse(line);if(item.kind==='cost-uninstrumented'){const values=cost.get(item.n)||[];values.push(...item.samples.map(s=>s.wallMs));cost.set(item.n,values);}
 }
 log({kind:'reproduction-audit',mode,run,pid,exit:0,stderrEmpty:true});
}
for(const [n,values]of cost){values.sort((a,b)=>a-b);log({kind:'cost-summary',n,count:values.length,minMs:values[0],medianMs:values[4],maxMs:values.at(-1)});}
for(const relative of ['node_modules/zod/v4/classic/from-json-schema.cjs','node_modules/zod/v4/classic/from-json-schema.js']){
 const lines=fs.readFileSync(relative,'utf8').split(/\r?\n/);const index=lines.findIndex(line=>line.includes('function resolveRef('));assert.ok(index>=0);
 log({kind:'runtime-converter',path:relative,startLine:index+1,snippet:lines.slice(index,index+22).map((text,i)=>({line:index+i+1,text}))});
}
assert.equal(fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()).length,0);
log({kind:'cleanup-audit',remainingFixtureDirectories:0,uniqueProbeProcesses:pids.size});
for(const name of fs.readdirSync(dir).sort())if(fs.statSync(join(dir,name)).isFile())log({kind:'evidence-hash',path:name,sha256:createHash('sha256').update(fs.readFileSync(join(dir,name))).digest('hex')});
log('Progress: audit complete; exit=0');fs.writeFileSync(join(dir,'audit.log'),output.join('\n')+'\n',{flag:'wx'});
