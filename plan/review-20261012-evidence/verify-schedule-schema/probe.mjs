import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const root = process.cwd();
const mode = process.argv[2];
const dir = resolve('plan/review-20261012-evidence/verify-schedule-schema');
const workspace = join(dir, `fixture-${mode}-${process.pid}`);
const agent = join(workspace, 'agent');
process.env.HOME = agent; process.env.USERPROFILE = agent; process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_BLACKHOLE_PASSIVE = 'true';
globalThis.fetch = () => { throw Error('Network forbidden'); };
console.log(`Progress: starting ${mode}; pid=${process.pid}; node=${process.version}`);
const imp = p => import(pathToFileURL(join(root,p)).href);
function hashes() {
 const entries = fs.readFileSync('plan/review-20261012-evidence/source-sha256.txt','utf8').split(/\r?\n/).flatMap(line => {
  const m=line.match(/^([A-Fa-f0-9]{64})\s+(.+)$/); if(!m)return [];
  const p=m[2].replaceAll('\\','/');
  return /^modules\/(schedule-prompt|json-schema)\/(src|extensions)\//.test(p) || /^modules\/(schedule-prompt|json-schema)\/README.md$/.test(p) ? [{p,expected:m[1].toLowerCase()}] : [];
 });
 assert.ok(entries.length>10);
 for(const {p,expected} of entries) {
  const actual=createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  console.log(JSON.stringify({kind:'baseline',path:p,expected,actual,equal:expected===actual}));
  assert.equal(actual,expected,p);
 }
 const req=createRequire(import.meta.url);
 for(const p of [req.resolve('zod'), 'node_modules/zod/src/v4/classic/from-json-schema.ts','node_modules/zod/v4/classic/from-json-schema.cjs','node_modules/zod/v4/classic/from-json-schema.js','node_modules/zod/package.json','node_modules/@earendil-works/pi-coding-agent/package.json']) {
  console.log(JSON.stringify({kind:'dependency-hash',path:p,sha256:createHash('sha256').update(fs.readFileSync(p)).digest('hex')}));
 }
 console.log(JSON.stringify({kind:'versions',zod:JSON.parse(fs.readFileSync('node_modules/zod/package.json')).version,pi:JSON.parse(fs.readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json')).version,baselineChecked:entries.length}));
}
async function schedule() {
 const {CronStorage}=await imp('modules/schedule-prompt/src/storage.ts');
 const {CronScheduler}=await imp('modules/schedule-prompt/src/scheduler.ts');
 const {createCronTool}=await imp('modules/schedule-prompt/src/tool.ts');
 const saved=Object.fromEntries(['setInterval','setTimeout','clearInterval','clearTimeout'].map(k=>[k,globalThis[k]]));
 const pending=new Set(); let callbackCalls=0;
 const makeTimer=(callback,ms)=>{const t={callback,ms,unref(){return this;},ref(){return this;}};pending.add(t);return t;};
 globalThis.setInterval=makeTimer; globalThis.setTimeout=makeTimer;
 globalThis.clearInterval=globalThis.clearTimeout=t=>pending.delete(t);
 const target=join(workspace,'.pi','schedule-prompts.json');
 fs.mkdirSync(join(workspace,'.pi'),{recursive:true});
 const ctx={cwd:workspace,mode:'print',hasUI:false,isProjectTrusted:()=>true,sessionManager:{getSessionId:()=> 'owner',getBranch:()=>[]}};
 const api={events:{emit(){}},sendMessage(){callbackCalls++;throw Error('No fire expected');},sendUserMessage(){callbackCalls++;throw Error('No fire expected');}};
 const original=fs.readFileSync; let reads=0,bytes=0;
 const instrument=()=>{fs.readFileSync=(p,...args)=>{const value=original(p,...args);if(typeof p==='string'&&resolve(p)===target){reads++;bytes+=Buffer.byteLength(value);}return value;};syncBuiltinESMExports();};
 const restore=()=>{fs.readFileSync=original;syncBuiltinESMExports();};
 const reset=()=>{reads=0;bytes=0;};
 const job=(i,overrides={})=>({id:String(i),name:`job-${i}`,type:'interval',schedule:'1h',intervalMs:3600000,prompt:'offline',enabled:true,session:'owner',createdAt:'2026-10-12T00:00:00Z',runCount:0,...overrides});
 try {
  for(const n of [10,100,500]) {
   console.log(`Progress: schedule N=${n}`);
   const jobs=Array.from({length:n},(_,i)=>job(i));
   const raw=JSON.stringify({version:1,jobs});fs.writeFileSync(target,raw);
   const storage=new CronStorage(workspace),scheduler=new CronScheduler(storage,api,ctx);
   const list=()=>createCronTool(()=>storage,()=>scheduler).execute('probe',{action:'list'},undefined,undefined,ctx);
   try {
    instrument();reset();scheduler.start(); assert.equal(reads,1);assert.equal(pending.size,n);
    console.log(JSON.stringify({kind:'control-startup',n,reads,timers:pending.size}));
    reset();const out=await list();assert.equal(out.isError,undefined);assert.equal(out.details.jobs.length,n);assert.equal(reads,n+1);assert.equal(bytes,(n+1)*Buffer.byteLength(raw));
    console.log(JSON.stringify({kind:'operation-count',n,reads,storeBytes:Buffer.byteLength(raw),totalReadBytes:bytes}));
    reset();for(const j of jobs)assert.ok(scheduler.getNextRun(j.id,j));assert.equal(reads,0);
    console.log(JSON.stringify({kind:'control-knownJob',n,reads}));
    restore();
    // Cost measurement has no read counter. Warm once, then three bounded samples.
    await list();const samples=[];
    for(let i=0;i<3;i++){const cpu=process.cpuUsage();const t=performance.now();const result=await list();const wallMs=performance.now()-t;const used=process.cpuUsage(cpu);assert.equal(result.details.jobs.length,n);samples.push({wallMs,cpuUserMs:used.user/1000,cpuSystemMs:used.system/1000});}
    console.log(JSON.stringify({kind:'cost-uninstrumented',n,samples}));
    scheduler.stop();assert.equal(pending.size,0);instrument();reset();await list();assert.equal(reads,1);
    console.log(JSON.stringify({kind:'control-stopped',n,reads}));restore();
   } finally {scheduler.stop();restore();}
  }
  for(const control of ['disabled','foreign']) {
   const jobs=Array.from({length:100},(_,i)=>job(i,control==='disabled'?{enabled:false}:{session:'other'}));fs.writeFileSync(target,JSON.stringify({version:1,jobs}));
   const storage=new CronStorage(workspace),scheduler=new CronScheduler(storage,api,ctx);
   try {scheduler.start();assert.equal(pending.size,0);instrument();reset();const result=await createCronTool(()=>storage,()=>scheduler).execute('probe',{action:'list'},undefined,undefined,ctx);assert.equal(reads,1);assert.equal(result.details.jobs.length,control==='disabled'?100:0);console.log(JSON.stringify({kind:'control-list',control,reads,rows:result.details.jobs.length,timers:pending.size}));}finally{scheduler.stop();restore();}
  }
  assert.equal(callbackCalls,0);assert.equal(pending.size,0);
  console.log(JSON.stringify({kind:'schedule-cleanup',callbacks:callbackCalls,pendingTimers:pending.size}));
 }finally{restore();Object.assign(globalThis,saved);fs.rmSync(workspace,{recursive:true,force:true});}
}
async function schema() {
 const {compileSchema}=await imp('modules/json-schema/src/schema.ts');
 const {validationPool}=await imp('modules/json-schema/src/validation-pool.ts');
 const {default:extension}=await imp('modules/json-schema/extensions/json-schema.ts');
 const base={$schema:'https://json-schema.org/draft/2020-12/schema',type:'object',$defs:{W:{type:'object',properties:{amount:{type:'number'}}}},properties:{x:{$ref:'#/$defs/W/properties/amount'}},required:['x']};
 const variants=[['deep-sync',base],['deep-worker',{...base,properties:{...base.properties,tag:{type:'string',pattern:'^a+$'}},required:['x','tag']}]];
 const data=(v,x)=>v==='deep-worker'?{x,tag:'aaa'}:{x};
 try {
  for(const [label,s] of variants) {
   const compiled=compileSchema(JSON.stringify(s));
   const invalidAccepted=await compiled.validate(data(label,{})); const validRejected=await compiled.validate(data(label,7));
   assert.equal(invalidAccepted,undefined);assert.ok(validRejected);
   const poolUsed=validationPool.slots.size; assert.equal(poolUsed,label==='deep-worker'?1:0);
   console.log(JSON.stringify({kind:'compile',label,compiled:true,invalidObjectAccepted:invalidAccepted===undefined,validNumberRejected:validRejected!==undefined,reason:validRejected,workerSlots:poolUsed}));
   if(label==='deep-worker'){assert.ok(await compiled.validate({x:{},tag:'bbb'}));console.log(JSON.stringify({kind:'control-pattern',label,rejectsWrongTag:true}));}
   const hooks=new Map();let registered,modelCalls=0;
   const sub=join(workspace,label);fs.mkdirSync(sub,{recursive:true});
   extension({registerFlag(){},registerTool(t){registered=t;},on:(name,fn)=>hooks.set(name,fn),getFlag:name=>name==='json-schema'?JSON.stringify(s):name==='json-output'?'output.json':undefined,getActiveTools:()=>[]});
   const ctx={cwd:sub,mode:'print',modelRegistry:{find(){return undefined;},complete(){modelCalls++;throw Error('Model forbidden');}}};
   const call=(name,event={})=>hooks.get(name)(event,ctx);
   await call('session_start');assert.equal(registered.name,'json_output');
   assert.deepEqual(registered.parameters.properties.x,s.properties.x,'provider pointer unchanged');
   assert.equal((await call('input')).action,'continue');
   const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:`Answer: ${JSON.stringify(data(label,{}))}`} ]};
   const replacement=await call('message_end',{message});assert.equal(replacement.message.content.length,0);
   await call('agent_end',{messages:[replacement.message]});await call('agent_settled',{aborted:false});await call('session_shutdown');
   const raw=fs.readFileSync(join(sub,'output.json'),'utf8');assert.deepEqual(JSON.parse(raw),data(label,{}));assert.equal(modelCalls,0);assert.equal(validationPool.slots.size,0);
   console.log(JSON.stringify({kind:'prose-fallback-delivery',label,raw,deliveredInvalidObject:true,toolExecuteCalls:0,modelCalls,activeTools:[],poolSlotsAfterShutdown:validationPool.slots.size}));
  }
  const inline={type:'object',properties:{x:{type:'number'}},required:['x']};
  const shallow={...base,properties:{x:{$ref:'#/$defs/W'}}};
  for(const [label,s,valid,invalid] of [['inline',inline,{x:7},{x:{}}],['shallow',shallow,{x:{amount:7}},{x:7}]]) {
   const c=compileSchema(JSON.stringify(s));assert.equal(await c.validate(valid),undefined);assert.ok(await c.validate(invalid));console.log(JSON.stringify({kind:'control-schema',label,validAccepted:true,invalidRejected:true}));
  }
  // Normal prose fallback control: skip an invalid candidate and deliver the first number, offline.
  const hooks=new Map();extension({registerFlag(){},registerTool(){},on:(n,f)=>hooks.set(n,f),getFlag:n=>n==='json-schema'?JSON.stringify(inline):n==='json-output'?'normal.json':undefined,getActiveTools:()=>[]});
  const ctx={cwd:workspace,mode:'print',modelRegistry:{complete(){throw Error('Model forbidden');}}};
  const call=(n,e={})=>hooks.get(n)(e,ctx);call('session_start');call('input');
  const m={role:'assistant',stopReason:'stop',content:[{type:'text',text:'Bad {"x":{}} then good {"x":7}'}]};
  const replacement=call('message_end',{message:m});call('agent_end',{messages:[replacement.message]});call('agent_settled',{aborted:false});await call('session_shutdown');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(workspace,'normal.json'),'utf8')),{x:7});console.log(JSON.stringify({kind:'control-prose',delivered:{x:7},modelCalls:0}));
 }finally{await validationPool.close();assert.equal(validationPool.slots.size,0);fs.rmSync(workspace,{recursive:true,force:true});console.log('Progress: schema workers closed and fixtures removed');}
}
try {
 if(mode==='hash')hashes(); else if(mode==='schedule')await schedule();else if(mode==='schema')await schema();else throw Error('Unknown mode');
 console.log(`Progress: ${mode} complete; exit=0`);
}catch(error){console.error(error);process.exitCode=1;}
