// P0 only: deterministic offline transport; history is read ONLY from provider context.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
 const dir = process.env.P0_CAPTURE!;
 const phase = process.env.P0_PHASE!;
 let requests = 0, executions = 0;
 const save = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
 const text = (m: any) => typeof m.content === "string" ? m.content : (m.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
 pi.on("session_start", async (_event, ctx) => {
  save("startup.json", { pid: process.pid, cwd: ctx.cwd, id: ctx.sessionManager.getSessionId(), file: ctx.sessionManager.getSessionFile(),
   selection: { provider: ctx.model?.provider, model: ctx.model?.id, thinking: pi.getThinkingLevel() },
   active: pi.getActiveTools(), registered: pi.getAllTools().map(t => t.name),
   defaultList: (await SessionManager.list(ctx.cwd)).map(s => ({id:s.id,path:s.path})),
   defaultAll: (await SessionManager.listAll()).map(s => ({id:s.id,path:s.path})),
   explicitList: (await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir())).map(s => ({id:s.id,path:s.path})) });
 });
 pi.registerTool({ name: "p0_nonce", label: "P0 nonce", description: "Creates an opaque nonce and records one local side effect", parameters: Type.Object({}),
  async execute(_id, _args, _signal, _update, ctx) {
   executions++;
   const nonce = randomBytes(24).toString("hex");
   appendFileSync(join(ctx.cwd, "side-effects.jsonl"), JSON.stringify({pid:process.pid,phase,nonce}) + "\n");
   const value = { nonce, opaque: randomBytes(16).toString("hex"), phase, active: pi.getActiveTools(), registered: pi.getAllTools().map(t=>t.name), callable: ctx.tools.map(t=>t.name) };
   return {content:[{type:"text",text:JSON.stringify(value)}],details:{opaque:value.opaque}};
  }
 });
 pi.registerProvider("p0-offline", {
  baseUrl:"http://127.0.0.1:1/never-contacted", apiKey:"offline-dummy", api:"p0-offline-api",
  models:["physical", "alternate"].map(id=>({id,name:`P0 ${id}`,reasoning:true,input:["text"] as const,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:10000000,maxTokens:1000})),
  streamSimple(model, context, options) {
   const stream = createAssistantMessageEventStream();
   const nth = ++requests;
   const message:any = {role:"assistant",provider:model.provider,api:model.api,model:model.id,content:[],stopReason:"pending",usage:{input:10,output:2,cacheRead:0,cacheWrite:0,totalTokens:12,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.now()};
   setImmediate(()=>{
    try {
     const tools = getCurrentTools(context.messages).map(t=>t.name);
     save(`request-${nth}.json`, {pid:process.pid,phase,nth,executionsBeforeRequest:executions,model:{provider:model.provider,id:model.id},reasoning:options?.reasoning,tools,messages:context.messages});
     assert.ok(!tools.includes("subagent"), "subagent declaration must be excluded");
     assert.deepEqual(tools, phase === "anchor" || phase === "large" ? [] : ["p0_nonce"]);
     const old = context.messages.find((m:any)=>m.role==="toolResult" && m.toolCallId==="p0-first-call") as any;
     if (phase === "resume" && nth === 1) {
      assert.equal(executions,0,"history verification must precede every new tool");
      assert.ok(context.messages.some((m:any)=>m.role==="user" && text(m).includes("P0_INITIAL_USER_MARKER")));
      assert.ok(old && !old.isError,"prior canonical tool result missing");
      const nonce = JSON.parse(text(old)).nonce;
      assert.match(nonce,/^[a-f0-9]{48}$/);
      assert.ok(context.messages.some((m:any)=>m.role==="assistant" && text(m)===`AWAIT_DECISION:${nonce}`),"prior final assistant missing");
      assert.ok(context.messages.some((m:any)=>m.role==="assistant" && m.content.some((b:any)=>b.type==="toolCall" && b.id==="p0-first-call")));
      const user = text(context.messages.filter((m:any)=>m.role==="user").at(-1));
      assert.ok(!user.includes(nonce),"new task must not smuggle prior nonce");
      save("history-verified-before-new-tool.json",{pid:process.pid,executions,nonce,priorRoles:context.messages.map((m:any)=>m.role),oldToolId:old.toolCallId});
     }
     stream.push({type:"start",partial:message});
     if (["new","resume"].includes(phase) && nth===1) {
      message.content=[{type:"toolCall",id:phase==="new"?"p0-first-call":"p0-second-call",name:"p0_nonce",arguments:{}}];
      stream.push({type:"toolcall_start",contentIndex:0,partial:message});
      stream.push({type:"toolcall_end",contentIndex:0,toolCall:message.content[0],partial:message});
      message.stopReason="toolUse";
     } else {
      const prior = context.messages.filter((m:any)=>m.role==="toolResult").at(-1) as any;
      const output = phase==="new" ? `AWAIT_DECISION:${JSON.parse(text(prior)).nonce}` : phase==="resume" ? "DECISION_B_COMPLETED" : "OFFLINE_DONE";
      message.content=[{type:"text",text:output,textSignature:"p0-opaque-text-signature"}];
      stream.push({type:"text_start",contentIndex:0,partial:message});
      stream.push({type:"text_delta",contentIndex:0,delta:output,partial:message});
      stream.push({type:"text_end",contentIndex:0,content:output,partial:message});
      message.stopReason="stop";
     }
     stream.push({type:"done",reason:message.stopReason,message});stream.end();
    } catch(error) {message.stopReason="error";message.errorMessage=String(error);stream.push({type:"error",reason:"error",error:message});stream.end();}
   });
   return stream;
  }
 });
 if (process.env.P0_NO_VIRTUAL !== "1") pi.registerVirtualModel({provider:"p0-router",id:"logical",name:"P0 logical selection",thinkingLevels:["low","high"],contextWindow:10000000,maxTokens:1000,
  route(request,ctx) {
   const state:any = request.state;
   save(`route-${requests+1}.json`,{selected:request.model.id,thinking:request.thinkingLevel,reason:request.reason,state});
   return {model:ctx.modelRegistry.find("p0-offline","physical")!,thinkingLevel:"low",state:state??{opaque:"p0-router-persisted-state"}};
  }
 });
}
