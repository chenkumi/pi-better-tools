import fs from 'node:fs';import {createHash} from 'node:crypto';import {join,resolve} from 'node:path';
const root=resolve('plan/review-20261012-evidence/verify-blackhole');
console.log('Progress: auditing final raw evidence, runtime versions, and cleanup');
const rows=JSON.parse(fs.readFileSync(join(root,'summary.json'),'utf8'));
for(const row of rows){if(row.exitCode!==0||!row.cleanup)throw Error('Final evidence incomplete');const stderr=fs.readFileSync(join(root,row.label+'.stderr.log'),'utf8');if(stderr)throw Error('Unexpected stderr');console.log(JSON.stringify({label:row.label,exitCode:row.exitCode,cleanup:row.cleanup,stdout:row.label+'.stdout.log',stderr:row.label+'.stderr.log',result:row.label+'.result.json'}));}
for(const file of ['node_modules/@earendil-works/pi-coding-agent/package.json','node_modules/esbuild/package.json']){const raw=fs.readFileSync(file);console.log(JSON.stringify({file,version:JSON.parse(raw).version,sha256:createHash('sha256').update(raw).digest('hex')}));}
const fixtureRoot=join(root,'fixtures');const left=fs.readdirSync(fixtureRoot);if(left.length)throw Error('Fixture leftovers');
console.log(JSON.stringify({node:process.version,finalProcesses:rows.length,exit0:rows.filter(r=>r.exitCode===0).length,fixtureLeftovers:left.length}));
const files=fs.readdirSync(root).filter(f=>fs.statSync(join(root,f)).isFile()&&!f.startsWith('final-audit.')&&f!=='evidence-sha256.txt');
fs.writeFileSync(join(root,'evidence-sha256.txt'),files.sort().map(f=>createHash('sha256').update(fs.readFileSync(join(root,f))).digest('hex')+'  '+f).join('\n')+'\n');
console.log('Progress: evidence integrity manifest saved');
