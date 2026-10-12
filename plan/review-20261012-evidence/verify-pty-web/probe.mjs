import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [type, kind, size] = process.argv.slice(2);
globalThis.fetch = async () => { throw new Error('Real fetch forbidden'); };
const load = p => import(pathToFileURL(resolve(p)).href);
console.log(JSON.stringify({phase:'start',type,kind,size,pid:process.pid,node:process.version,v8:process.versions.v8,platform:process.platform}));
if (type === 'web') {
  const {search} = await load('modules/web-tools/src/search.ts');
  const {defaults} = await load('modules/web-tools/src/config.ts');
  const n = Number(size), c = defaults(); c.provider='brave'; c.providers.brave={apiKey:'OFFLINE_FIXTURE_ONLY'}; c.searchTimeoutMs=1000;
  const description=(kind==='angles'?'<':'x').repeat(n);
  const payload=JSON.stringify({web:{results:[{title:'<b>Fixture</b>',url:'https://example.org/a',description}]}});
  assert.ok(Buffer.byteLength(payload)<2*1024*1024);
  let calls=0, passedSignal, readDoneAt;
  const http=async(url,init)=>{
    calls++; assert.equal(new URL(url).hostname,'api.search.brave.com'); assert.equal(init.redirect,'error'); passedSignal=init.signal;
    const response=new Response(payload);
    const getReader=response.body.getReader.bind(response.body);
    response.body.getReader=(...a)=>{const reader=getReader(...a), read=reader.read.bind(reader); reader.read=async(...b)=>{const part=await read(...b); if(part.done)readDoneAt=performance.now(); return part;}; return reader;};
    return response;
  };
  console.log('Imports complete; bounded search measurement starting');
  const start=performance.now();
  const result=await search(c,{query:'offline fixture',numResults:1},undefined,http);
  const end=performance.now();
  assert.equal(calls,1); assert.equal(result.results.length,1); assert.equal(result.results[0].snippet,description.slice(0,1500)); assert.equal(result.results[0].title,'Fixture');
  console.log(JSON.stringify({phase:'result',type,kind,n,calls,bodyBytes:Buffer.byteLength(payload),totalMs:end-start,afterReadMs:end-readDoneAt,snippetLength:result.results[0].snippet.length,signalAbortedAtReturn:passedSignal.aborted,maxRSS:process.resourceUsage().maxRSS}));
  console.log('HTTP fixture completed; response cancelled by product finally; no network created');
} else {
  const {PtySessionManager}=await load('modules/pty-terminal/src/pty-manager.ts');
  let emit, exit, stream, callbacks=[], retries=[];
  if(type==='input'){
    const source=readFileSync('node_modules/node-pty/lib/unixTerminal.js','utf8');
    const begin=source.indexOf('var CustomWriteStream ='), end=source.indexOf('//# sourceMappingURL=',begin); assert.ok(begin>=0&&end>begin);
    const sandbox=vm.createContext({Buffer,console,fs:{write(fd,buffer,offset,callback){callbacks.push({callback,remaining:buffer.length-offset});}},setImmediate(callback){retries.push(callback);return callback;},clearImmediate(handle){const i=retries.indexOf(handle);if(i>=0)retries.splice(i,1);}});
    vm.runInContext(source.slice(begin,end),sandbox); stream=new sandbox.CustomWriteStream(123,'utf8');
  }
  const manager=new PtySessionManager({spawnPty:()=>({pid:123,onData(cb){emit=cb;},onExit(cb){exit=cb;},write(data){stream?.write(data);},resize(){},kill(){exit({exitCode:0});}})});
  const {sessionId}=manager.spawn('fake-owned',[],{},process.cwd());
  try {
    if(type==='input'){
      const chunk='x'.repeat(65536); let delivered=0;
      for(let i=0;i<32;i++){
        manager.write(sessionId,chunk);
        if(kind==='drain'){while(callbacks.length){const {callback,remaining}=callbacks.shift(); delivered+=remaining;callback(null,remaining);}}
        if((i+1)%8===0)console.log(`Accepted ${i+1} bounded input writes`);
      }
      const queuedBytes=stream._writeQueue.reduce((n,t)=>n+t.buffer.length-t.offset,0);
      if(kind==='blocked'){assert.equal(callbacks.length,1);assert.equal(stream._writeQueue.length,32);assert.equal(queuedBytes,2097152); callbacks.shift().callback({code:'EAGAIN'});assert.equal(retries.length,1);assert.equal(stream._writeQueue.length,32);}else{assert.equal(queuedBytes,0);assert.equal(delivered,2097152);}
      console.log(JSON.stringify({phase:'result',type,kind,acceptedWrites:32,queuedBytes,queuedTasks:stream._writeQueue.length,retries:retries.length,delivered,modelOnly:true}));
    }else{
      const w=262144;
      const text=kind==='within'?'READY\n'+'x'.repeat(w-6):kind==='prefix'?'READY\n'+'x'.repeat(w):'x'.repeat(w)+'READY\n';
      emit(text);
      const snapshot=await manager.readEx(sessionId,{timeoutMs:0,waitFor:/READY/});
      assert.equal(snapshot.text,text);assert.equal(snapshot.dropped,undefined);assert.equal(snapshot.start,0); assert.equal(snapshot.end,text.length);
      assert.equal(snapshot.wait,kind==='prefix'?'timeout':'matched');
      console.log(JSON.stringify({phase:'result',type,kind,length:text.length,wait:snapshot.wait,retainedReady:snapshot.text.includes('READY'),dropped:false,realWorker:true}));
    }
  }finally{
    const cleanup=await manager.shutdown();assert.deepEqual(cleanup,{retained:[],errors:[]});assert.equal(manager.list().length,0);
    if(stream){stream.dispose();stream._writeQueue.length=0;}callbacks.length=0;retries.length=0;
    console.log('Worker/fake transport and bounded VM queue cleanup complete');
  }
}
