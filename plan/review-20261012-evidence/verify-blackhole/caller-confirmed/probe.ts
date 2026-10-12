import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve,sep} from 'node:path';
import * as p from '../../../modules/blackhole/src/om/pending.ts';
import * as c from '../../../modules/blackhole/src/om/cleanup.ts';
import {Runtime} from '../../../modules/blackhole/src/om/runtime.ts';
import {runConsolidationPipeline,anyStageDue} from '../../../modules/blackhole/src/om/consolidation.ts';
import {handleCleanup} from '../../../modules/blackhole/src/commands/cleanup.ts';

const [kind,mode]=process.argv.slice(2), fault=mode==='fault';
const agent=resolve(process.env.PI_CODING_AGENT_DIR!);
assert.ok(agent.includes(`${sep}verify-blackhole${sep}`));
assert.equal(process.env.PI_BLACKHOLE_PASSIVE,'true');
globalThis.fetch=async()=>{throw Error('Network forbidden');};
const sid='verify-live-session',dir=join(agent,'pi-blackhole'),main=join(dir,`${sid}-pending.json`),stale=join(dir,`${sid}-pending.stale.json`),sessions=join(agent,'sessions'),session=join(sessions,'live.jsonl');
console.log(`Progress: starting ${kind} ${mode}, pid=${process.pid}`);
fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(sessions,{recursive:true});
fs.writeFileSync(session,JSON.stringify({type:'session',version:3,id:sid,timestamp:'2026-10-12T00:00:00Z',cwd:agent})+'\n');
const original={writeFileSync:fs.writeFileSync,readFileSync:fs.readFileSync,unlinkSync:fs.unlinkSync,renameSync:fs.renameSync,mkdirSync:fs.mkdirSync};
let armed=false,errors=0,reads=0;
const inside=(path:any)=>{const r=resolve(String(path));return r===agent||r.startsWith(agent+sep);};
fs.writeFileSync=((path:any,...a:any[])=>{assert.ok(inside(path),'write outside isolated agent');if(resolve(String(path))===main&&armed){armed=false;errors++;console.log('Injected ENOSPC at pending main write');throw Object.assign(Error('Injected ENOSPC'),{code:'ENOSPC'});}return (original.writeFileSync as any)(path,...a);}) as any;
fs.readFileSync=((path:any,...a:any[])=>{if(resolve(String(path))===session){reads++;if(armed){errors++;console.log('Injected EACCES at live session header read');throw Object.assign(Error('Injected EACCES'),{code:'EACCES'});}}return (original.readFileSync as any)(path,...a);}) as any;
fs.unlinkSync=((path:any)=>{assert.ok(inside(path),'unlink outside isolated agent');return original.unlinkSync(path);}) as any;
fs.renameSync=((a:any,b:any)=>{assert.ok(inside(a)&&inside(b),'rename outside isolated agent');return original.renameSync(a,b);}) as any;
fs.mkdirSync=((path:any,...a:any[])=>{assert.ok(inside(path),'mkdir outside isolated agent');return (original.mkdirSync as any)(path,...a);}) as any;
syncBuiltinESMExports();
const batch=(id:string,cover:string)=>({coversUpToId:cover,data:{coversUpToId:cover,observations:[{id,content:id,timestamp:'2026-10-12T00:00:00Z',relevance:'high',sourceEntryIds:[cover],tokenCount:5}]}});
try {
 if(kind==='pending-helper') {
  p.savePendingObservation(sid,batch('aaaaaaaaaaaa','raw-a'));
  armed=fault;p.savePendingObservation(sid,batch('bbbbbbbbbbbb','raw-b'));
  if(fault){assert.equal(fs.existsSync(main),false);assert.ok(fs.readFileSync(stale,'utf8').includes('aaaaaaaaaaaa'));}
  p.writePendingCursors(sid,{observer:{entryId:'raw-b',state:'recorded'}});
  p.writePendingCursors(sid,{observer:{entryId:'raw-b',state:'recorded'}});
  const state=p.readPendingState(sid);
  assert.equal(state.observationBatches?.length??0,fault?0:2);
  assert.equal(state.cursors!.observer!.entryId,'raw-b');
  assert.equal(fs.readFileSync(stale,'utf8').includes('aaaaaaaaaaaa'),!fault);
  console.log(JSON.stringify({kind,mode,errors,batches:state.observationBatches?.length??0,cursor:state.cursors!.observer,backupContainsA:fs.readFileSync(stale,'utf8').includes('aaaaaaaaaaaa')}));
 } else if(kind==='pending-caller') {
  const runtime=new Runtime(agent);runtime.configLoaded=true;
  Object.assign(runtime.config,{memory:true,compaction:'manual',observeAfterTokens:1,reflectAfterTokens:1000000,observationsPoolMaxTokens:1000000,showWorkerNotifications:true,debug:false,workerAttemptTimeoutMs:5000});
  runtime.resolveModel=async()=>({ok:true,source:'candidate',candidateConfig:{provider:'synthetic',id:'offline'},model:{provider:'synthetic',id:'offline',contextWindow:1000000},apiKey:'dummy'}) as any;
  const entries=[{type:'message',id:'raw-b',parentId:null,timestamp:'2026-10-12T00:00:00Z',message:{role:'user',content:[{type:'text',text:'Independent observer evidence '.repeat(30)}]}}];
  const notices:string[]=[];
  const ctx:any={cwd:agent,hasUI:true,ui:{notify:(s:string)=>notices.push(s)},modelRegistry:{},sessionManager:{getBranch:()=>entries,getSessionId:()=>sid,getLeafId:()=>entries.at(-1)!.id}};
  const pi:any={appendEntry(){throw Error('manual must not append');}};
  armed=fault;
  await runConsolidationPipeline(pi,runtime,ctx,runtime.captureGeneration(sid));
  await new Promise<void>(r=>queueMicrotask(r));
  assert.equal((globalThis as any).__workerCalls,1,'synthetic worker must really be called');
  const state=p.readPendingState(sid);
  assert.equal(state.observationBatches?.length??0,fault?0:1);
  assert.equal(state.cursors?.observer?.entryId,'raw-b');assert.equal(state.cursors?.observer?.state,'recorded');
  assert.ok(notices.some(s=>s.includes('observer running on')),'running notice owns the once-per-phase gate');
  assert.equal(notices.some(s=>s.includes('1 observation recorded')),false,'recorded notice suppressed by real info gate');
  const reloaded=new Runtime(agent);Object.assign(reloaded.config,runtime.config);reloaded.loadCursorsFromPending(sid);
  assert.equal(anyStageDue(entries as any,reloaded,undefined),false);
  const before=(globalThis as any).__workerCalls;
  await runConsolidationPipeline(pi,reloaded,ctx,reloaded.captureGeneration(sid));
  await new Promise<void>(r=>queueMicrotask(r));
  assert.equal((globalThis as any).__workerCalls,before,'cursor suppresses replay after reload');
  console.log(JSON.stringify({kind,mode,errors,workerCalls:before,batches:state.observationBatches?.length??0,cursor:state.cursors!.observer,reloadedDue:false,reloadedWorkerCalls:(globalThis as any).__workerCalls,notices}));
 } else if(kind==='orphan-helper'||kind==='orphan-command') {
  p.savePendingObservation(sid,batch('aaaaaaaaaaaa','raw-a'));
  assert.equal(c.analyzeOrphaned().active.length,1);
  armed=fault;
  if(kind==='orphan-helper') {
   const report=c.analyzeOrphaned();assert.equal(report.orphaned.length,fault?1:0);
   const deleted=c.deleteOrphanedBatch(report.orphaned);
   assert.equal(deleted,fault?1:0);
   console.log(JSON.stringify({kind,mode,errors,reads,active:report.active.length,orphaned:report.orphaned.length,deleted,pendingExists:fs.existsSync(main),sessionExists:fs.existsSync(session)}));
  } else {
   const notices:string[]=[],rendered:string[]=[];let opened=0;
   const ctx:any={cwd:agent,mode:'tui',hasUI:true,sessionManager:{getSessionId:()=>sid},ui:{notify:(s:string)=>notices.push(s),custom:async(factory:any)=>{opened++;let result:any;const component=factory({}, {fg:(_:string,s:string)=>s,bg:(_:string,s:string)=>s},{},(r:any)=>{result=r;});rendered.push(...component.render(80));component.handleInput('\r');return result;}}};
   await handleCleanup(ctx);assert.equal(opened,fault?1:0);
   if(fault){assert.ok(rendered.some(s=>s.includes('Orphaned Pending Files')));assert.ok(notices.some(s=>s.includes('All 1 orphaned pending file removed')));}
   console.log(JSON.stringify({kind,mode,errors,reads,opened,rendered,notices,pendingExists:fs.existsSync(main),sessionExists:fs.existsSync(session),liveContextSession:sid}));
  }
  assert.equal(fs.existsSync(main),!fault);assert.equal(fs.existsSync(session),true);
 } else throw Error('unknown probe');
 assert.equal(errors,fault?1:0);
} finally {
 Object.assign(fs,original);syncBuiltinESMExports();
 fs.rmSync(agent,{recursive:true,force:true});
 console.log(JSON.stringify({cleanup:'isolated agent removed',agentExists:fs.existsSync(agent)}));
}
console.log('Progress: probe complete; mocks restored; no model/network used');
