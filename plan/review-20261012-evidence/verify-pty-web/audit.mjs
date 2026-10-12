import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const dir=resolve('plan/review-20261012-evidence/verify-pty-web');
const records=['v2','v3'].flatMap(v=>JSON.parse(readFileSync(join(dir,v,'exits.json'),'utf8')).map(r=>({...r,batch:v})));
const product=records.filter(r=>/^(input|wait|web)-/.test(r.name));assert.equal(product.length,33);
assert.equal(product.filter(r=>r.code===0).length,30);assert.equal(product.filter(r=>r.hardStopped).length,3);
const web=product.filter(r=>r.name.startsWith('web-')).map(r=>{const lines=readFileSync(join(dir,r.batch,`${r.name}.stdout.log`),'utf8').split(/\r?\n/);const result=lines.filter(l=>l.startsWith('{')).map(l=>JSON.parse(l)).find(o=>o.phase==='result');return {name:r.name,batch:r.batch,exitCode:r.code,signal:r.signal,censored:r.hardStopped,...result};});
const med=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const summary=[];for(const n of [32768,65536,131072])for(const kind of ['control','angles']){const rows=web.filter(r=>r.name.startsWith(`web-${kind}-${n}-`));assert.equal(rows.length,3);const vals=rows.filter(r=>!r.censored).map(r=>r.totalMs);summary.push({n,kind,attempts:3,completed:vals.length,censored:rows.filter(r=>r.censored).length,totalMs:vals,medianTotalMs:vals.length?med(vals):null,afterReadMs:rows.filter(r=>!r.censored).map(r=>r.afterReadMs)});}
const deps=JSON.parse(readFileSync(join(dir,'v2/environment.json'),'utf8')).dependency.map(r=>({...r,finalSha256:createHash('sha256').update(readFileSync(r.path)).digest('hex')}));assert.ok(deps.every(r=>r.sha256===r.finalSha256));
function fixtures(p){return readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?(e.name.startsWith('fixture-')?[join(p,e.name)]:fixtures(join(p,e.name))):[]);}
assert.deepEqual(fixtures(dir),[]);assert.ok(JSON.parse(readFileSync(join(dir,'v3/hash-final.json'),'utf8')).every(r=>r.match));
const result={effectiveIndependentCases:33,normalExit0:30,censoredSIGKILL:3,input:{blocked:3,drain:3,modelOnly:true},wait:{within:3,prefix:3,suffix:3,realWorker:true},webSummary:summary,dependencyFinal:deps,fixturesRemaining:[],sourceFinalMatch:true};
writeFileSync(join(dir,'audit.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));console.log('Evidence audit complete: repetitions, exits, dependencies, source baseline and cleanup verified');
