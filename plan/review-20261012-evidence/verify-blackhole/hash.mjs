import fs from 'node:fs';
import {createHash} from 'node:crypto';
console.log('Progress: verifying complete SHA-256 baseline for Blackhole');
let checked=0,bad=0;
for(const line of fs.readFileSync('plan/review-20261012-evidence/source-sha256.txt','utf8').split(/\r?\n/)) {
 const m=line.match(/^([a-f\d]{64})\s+(.+)$/i);if(!m)continue;
 const p=m[2].replaceAll('\\','/');if(!p.startsWith('modules/blackhole/'))continue;
 const actual=createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 const equal=actual===m[1].toLowerCase();checked++;bad+=!equal;
 console.log(JSON.stringify({path:p,expected:m[1].toLowerCase(),actual,equal}));
}
console.log(JSON.stringify({checked,mismatches:bad}));if(!checked||bad)process.exitCode=1;
