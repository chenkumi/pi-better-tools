import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const dir=resolve('plan/review-20261012-evidence/verify-schedule-schema');
const env={...process.env,HOME:join(dir,'isolated-home'),USERPROFILE:join(dir,'isolated-home'),PI_CODING_AGENT_DIR:join(dir,'isolated-agent'),PI_BLACKHOLE_PASSIVE:'true',TSX_DISABLE_CACHE:'1'};
const summary=[];let failures=0;
for(const [mode,run] of [['hash',0],...['schedule','schema'].flatMap(mode=>[1,2,3].map(run=>[mode,run])),['hash',4]]) {
 console.log(`Progress: launching ${mode} repetition=${run}`);
 const args=['--import','tsx',join(dir,'probe.mjs'),mode];
 const result=spawnSync(process.execPath,args,{env,cwd:process.cwd(),encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 const entry={mode,run,command:[process.execPath,...args],exit:result.status,signal:result.signal,error:result.error?.message};
 const log=join(dir,`${mode}-${run}.log`);
 fs.writeFileSync(log,`${JSON.stringify(entry)}\n--- STDOUT ---\n${result.stdout||''}\n--- STDERR ---\n${result.stderr||''}\n--- END ---\nexit=${result.status}\nsignal=${result.signal}\nerror=${result.error?.message||''}\n`,{flag:'wx'});
 summary.push({...entry,log});if(result.status!==0)failures++;
 console.log(result.stdout||'');if(result.stderr)console.error(result.stderr);
 console.log(`Progress: ${mode} repetition=${run} exit=${result.status}`);
}
fs.writeFileSync(join(dir,'summary.json'),JSON.stringify({createdAt:new Date().toISOString(),failures,runs:summary},null,2)+'\n',{flag:'wx'});
console.log(`Progress: all probes finished; failures=${failures}`);process.exitCode=failures?1:0;
