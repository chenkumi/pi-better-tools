import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { invokeCli, isolatedEnv } from "./fixtures/pi-cli-harness.ts";

// Deliberate direct-CLI P0 experiment, NOT production child dispatch / parent E2E.
const cli = process.env.PI_SUBAGENTS_TEST_CLI;
const expectedPiVersion = process.env.PI_SUBAGENTS_TEST_EXPECTED_VERSION ?? JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")).devDependencies["@earendil-works/pi-coding-agent"];
assert.match(expectedPiVersion, /^\d+\.\d+\.\d+$/, "Expected CLI version must be an explicit release or the fixed root baseline");
const project = fileURLToPath(new URL("../",import.meta.url));
const fixture = join(project,"tests/fixtures/pi-session-provider.ts");
const evidence = resolve(process.env.PI_SUBAGENTS_TEST_EVIDENCE ?? join(project,"issues/IMPL-20260930-resumable-subagents/p0"),`run-${new Date().toISOString().replace(/[:.]/g,"-")}-${process.pid}`);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const jsonl = (s:string) => s.split("\n").filter(Boolean).map(line=>JSON.parse(line));
const json = async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const save = async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2));
// Only fingerprint repository inputs. Never read the developer's real auth/settings/trust files.
const globals = [join(project,"package.json"),fileURLToPath(new URL("../../../package-lock.json",import.meta.url)),join(project,"README.md"),...(await readdir(join(project,"extensions/subagent"))).map(f=>join(project,"extensions/subagent",f))];
async function fingerprints() {return Promise.all(globals.map(async path=>{try{return {path,sha256:sha(await readFile(path))};}catch(e:any){if(e.code==="ENOENT")return {path,absent:true};throw e;}}));}
const baseline = await fingerprints();
await mkdir(evidence,{recursive:true});
await save(join(evidence,"baseline-fingerprints.json"),baseline);

async function invoke(root:string,name:string,phase:string,sessionArgs:string[],selection:string[]=[],prompt="P0_INITIAL_USER_MARKER: work until a decision is required.",noVirtual=false) {
 const capture=join(root,"capture",name);await mkdir(capture,{recursive:true});
 const task=join(root,`${name}-task.txt`);await writeFile(task,prompt);
 const args=[resolve(cli!),"--mode","json","-p","--offline","--no-extensions","--no-context-files","--no-skills","--no-prompt-templates","--no-themes","-e",project,"-e",fixture,
  "--exclude-tools","subagent","--tools",phase==="anchor"?"":"p0_nonce",...selection,...sessionArgs,`@${task}`];
 const env={...isolatedEnv(root),P0_CAPTURE:capture,P0_PHASE:phase,P0_NO_VIRTUAL:noVirtual?"1":"0"};
 await save(join(capture,"argv.json"),{executable:process.execPath,args,cwd:root,environment:env,taskBytes:Buffer.byteLength(prompt),taskSha256:sha(prompt)});
 console.log(`[progress] Starting installed CLI: ${name}`);
 const result=await invokeCli(resolve(cli!),args.slice(1),root,env);
 const actual={...result,outBytes:Buffer.byteLength(result.stdout),errBytes:Buffer.byteLength(result.stderr)};
 await writeFile(join(capture,"events.jsonl"),actual.stdout);await writeFile(join(capture,"stderr.txt"),actual.stderr);
 await save(join(capture,"exit.json"),{code:actual.code,pid:actual.pid,outBytes:actual.outBytes,errBytes:actual.errBytes});
 return {...actual,capture,events:jsonl(actual.stdout)};
}
function success(actual:any) {
 assert.equal(actual.code,0,actual.stderr);
 assert.ok(actual.events.some((e:any)=>e.type==="agent_settled"));
 const last=actual.events.filter((e:any)=>e.type==="message_end"&&e.message?.role==="assistant").at(-1)?.message;
 assert.equal(last?.stopReason,"stop",last?.errorMessage);
}
async function setup(root:string,changed=false){await mkdir(join(root,"config"),{recursive:true});await save(join(root,"config/settings.json"),{defaultProvider:"p0-offline",defaultModel:changed?"alternate":"physical",defaultThinkingLevel:changed?"low":"off",defaultTools:changed?["read","subagent"]:["write"],compaction:{enabled:false},cacheWarming:"off",retry:{enabled:false},defaultProjectTrust:"never"});await writeFile(join(root,"config/auth.json"),"{}\n");}
async function isolated(name:string,fn:(root:string,out:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),"pi-session-p0-"));const out=join(evidence,name);await mkdir(out,{recursive:true});
 try{await setup(root);await fn(root,out);await save(join(out,"assertions.json"),{status:"passed"});}
 catch(e:any){await save(join(out,"assertions.json"),{status:"failed",error:e.stack??String(e)});throw e;}
 finally{
  try{await cp(root,join(out,"sandbox"),{recursive:true});}finally{await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  await save(join(out,"cleanup.json"),{root,removed:await stat(root).then(()=>false,()=>true)});
  const final=await fingerprints();await save(join(evidence,"final-fingerprints.json"),final);assert.deepEqual(final,baseline,"production and global auth/settings/trust must not change");
  console.log(`[progress] Evidence preserved and isolated root removed: ${name}`);
 }
}
for(const logical of [false,true])test(`P0 actual CLI new/exact-file resume (${logical?"virtual":"physical"})`,{skip:!cli&&"Set PI_SUBAGENTS_TEST_CLI; skipped is not a pass",timeout:240000},async()=>isolated(logical?"virtual":"physical",async(root,out)=>{
 const version=await new Promise<string>((done,reject)=>{const p=spawn(process.execPath,[resolve(cli!),"--version"],{stdio:["ignore","pipe","pipe"],env:{...process.env,PI_CODING_AGENT_DIR:join(root,"config"),PI_OFFLINE:"1"}});let s="";p.stdout.on("data",b=>s+=b);p.on("error",reject);p.on("close",code=>code===0?done(s.trim()):reject(Error(`version exit ${code}`)));});assert.equal(version,expectedPiVersion);await save(join(out,"host.json"),{version,node:process.version,platform:process.platform,cli});
 const anchorId=ulid().toUpperCase();const anchor=await invoke(root,"anchor","anchor",["--session-id",anchorId],["--model","p0-offline/physical","--thinking","off"],"P0 picker anchor");success(anchor);
 const id=ulid().toUpperCase(),dir=join(root,"config/subagent-sessions",id,"pi");await mkdir(dir,{recursive:true});
 const model=logical?"p0-router/logical":"p0-offline/physical";
 const fixed=["--model",model,"--thinking","high"];
 const first=await invoke(root,"new","new",["--session-dir",dir,"--session-id",id],fixed);success(first);
 const native=join(dir,(await readdir(dir)).find(f=>f.endsWith(".jsonl"))!);const before=await readFile(native);await writeFile(join(out,"native-before.jsonl"),before);
 assert.equal(jsonl(before.toString())[0].id,id);assert.equal(first.events[0].id,id);
 await setup(root,true);
 const second=await invoke(root,"resume","resume",["--session-dir",dir,"--session",native],fixed,"P0_DECISION_B: use B and complete the prior work.");success(second);
 assert.notEqual(first.pid,second.pid);assert.equal(second.events[0].id,id);
 const after=await readFile(native);await writeFile(join(out,"native-after.jsonl"),after);assert.ok(after.subarray(0,before.length).equals(before),"resume must preserve prior bytes");
 const verified=await json(join(second.capture,"history-verified-before-new-tool.json"));assert.equal(verified.executions,0);
 assert.ok(!second.stdout.includes(verified.nonce),"no old opaque result may be replayed anywhere on stdout");
 assert.ok(!second.stdout.includes("P0_INITIAL_USER_MARKER"),"old user must not be replayed anywhere on stdout");
 const restoredRequest=await json(join(second.capture,"request-1.json"));
 assert.ok(restoredRequest.messages.some((m:any)=>m.role==="assistant"&&m.content.some((b:any)=>b.textSignature==="p0-opaque-text-signature")));
 const currentUsage=[first,second].map(run=>run.events.filter((e:any)=>e.type==="message_end"&&e.message?.role==="assistant").reduce((n:number,e:any)=>n+e.message.usage.totalTokens,0));
 assert.deepEqual(currentUsage,[24,24],"current invocation usage must not count prior assistants");
 assert.equal(second.events.filter((e:any)=>e.type==="message_end"&&e.message?.role==="user").length,1);
 for(const e of second.events){if(e.type==="message_end"){assert.ok(!JSON.stringify(e.message).includes("AWAIT_DECISION:"));assert.notEqual(e.message?.toolCallId,"p0-first-call");}if(e.type==="tool_execution_start")assert.notEqual(e.toolCallId,"p0-first-call");}
 const effects=jsonl(await readFile(join(root,"side-effects.jsonl"),"utf8"));assert.equal(effects.length,2);assert.equal(effects.filter(e=>e.phase==="new").length,1);
 for(const run of [first,second]){
  const start=await json(join(run.capture,"startup.json"));assert.equal(start.selection.model,logical?"logical":"physical");assert.equal(start.selection.thinking,"high");
  for(const key of ["active","registered"])assert.ok(!start[key].includes("subagent"));
  const request=await json(join(run.capture,"request-1.json"));assert.equal(request.model.id,"physical");assert.equal(request.reasoning,logical?"low":"high");
  const tool=run.events.find((e:any)=>e.type==="message_end"&&e.message?.role==="toolResult")?.message;assert.ok(tool&&!tool.isError);
  const registry=JSON.parse(tool.content[0].text);for(const key of ["active","registered","callable"])assert.ok(!registry[key].includes("subagent"));
 }
 const start=await json(join(second.capture,"startup.json"));assert.ok(start.defaultList.some((s:any)=>s.id===anchorId));assert.ok(start.defaultAll.some((s:any)=>s.id===anchorId));assert.ok(!start.defaultList.some((s:any)=>s.id===id));assert.ok(!start.defaultAll.some((s:any)=>s.id===id));assert.ok(start.explicitList.some((s:any)=>s.id===id));
 const entries=jsonl(after.toString());assert.equal(entries.filter(e=>e.type==="model_change").at(-1)?.modelId,logical?"logical":"physical");assert.equal(entries.filter(e=>e.type==="thinking_level_change").at(-1)?.thinkingLevel,"high");
 assert.ok(entries.some(e=>e.message?.content?.some?.((b:any)=>b.textSignature==="p0-opaque-text-signature")));
 // Evidence-only projection, not a production writer or a reconstructed native session.
 const segments=[first,second].map(run=>run.events.filter((e:any)=>e.type==="message_end").flatMap((e:any)=>{
  const m=e.message,timestamp=new Date(m.timestamp).toISOString();
  if(m.role==="user")return [{type:"user",timestamp,content:m.content}];
  if(m.role==="toolResult")return [{type:"tool_result",timestamp,callId:m.toolCallId,isError:m.isError,content:m.content}];
  if(m.role==="assistant")return m.content.filter((b:any)=>["text","toolCall"].includes(b.type)).map((b:any)=>b.type==="text"?{type:"assistant",timestamp,content:b.text}:{type:"tool_call",timestamp,callId:b.id,name:b.name,arguments:b.arguments});return [];
 }).map((e:any)=>JSON.stringify(e)+"\n").join(""));
 await writeFile(join(out,"segment-1.jsonl"),segments[0]);await writeFile(join(out,"segment-2.jsonl"),segments[1]);await writeFile(join(out,"view.jsonl"),segments.join(""));
 const viewBytes=Buffer.byteLength(segments.join(""));await save(join(out,"measurements.json"),{firstPid:first.pid,secondPid:second.pid,id,nativeFile:basename(native),nativeBefore:before.length,nativeAfter:after.length,nativeGrowth:after.length-before.length,viewBytes,segmentsBytes:viewBytes,spoolBytes:0,spoolNote:"No production spool used in direct-CLI P0",nativePlusViewPlusSegments:after.length+2*viewBytes,currentInvocationTokens:currentUsage,sideEffects:effects.length,stdoutFirst:first.outBytes,stdoutSecond:second.outBytes,newUserEvents:second.events.filter((e:any)=>e.type==="message_end"&&e.message?.role==="user").length,historyVerifiedBeforeNewTool:verified});
 if(logical){
  const copy=join(root,"missing-virtual.jsonl");await writeFile(copy,after);
  const missing=await invoke(root,"missing-explicit","anchor",["--session-dir",dir,"--session",copy],fixed,"P0 unavailable virtual selection",true);
  assert.notEqual(missing.code,0,"explicit missing logical model must not silently fall back");
  const fallbackCopy=join(root,"fallback-virtual.jsonl");await writeFile(fallbackCopy,after);
  const fallback=await invoke(root,"missing-implicit","anchor",["--session-dir",dir,"--session",fallbackCopy],[],"P0 observe native implicit fallback",true);success(fallback);
  const fallbackStart=await json(join(fallback.capture,"startup.json"));assert.equal(fallbackStart.selection.model,"physical");
  await save(join(out,"virtual-caveat.json"),{explicitMissingExit:missing.code,implicitMissingExit:fallback.code,implicitSelection:fallbackStart.selection,nativeRouterState:entries.filter(e=>e.customType==="pi.virtual-model-state"),routes:[await json(join(first.capture,"route-1.json")),await json(join(second.capture,"route-1.json"))]});
 }
}));
console.log(`[progress] P0 evidence root: ${evidence}`);
