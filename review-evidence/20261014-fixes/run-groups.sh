#!/bin/bash
# Sequential verification groups (isolated, no concurrency: jiti cache and temp dirs are shared).
cd /d/GitHub/pi-better-tools-main
F=review-evidence/20261014-fixes
run() { name="$1"; shift; echo "Progress: starting $name $(date +%T)"; "$@" > "$F/group-$name.log" 2>&1; echo "exit $?" >> "$F/group-$name.log"; echo "Progress: finished $name -> $(tail -1 $F/group-$name.log)"; }
run typecheck npm run typecheck
run unit npm test
for m in json-schema schedule-prompt fork monitor shell-tools web-tools; do run "module-$m" npm run test:module -- $m; done
run cross npm run test:cross
echo "Progress: all groups done"
