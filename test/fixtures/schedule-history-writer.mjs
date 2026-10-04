import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [project, storeRoot, role, barrierDir, nowArg] = process.argv.slice(2);
const now = Number(nowArg);
const waitFile = (file) => {
  const deadline = Date.now() + 12000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error('Probe barrier expired');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
const origRead = fs.readFileSync;
const origMkdir = fs.mkdirSync;
let attempted = false;
fs.mkdirSync = function(file, ...args) {
  if (role === "contender" && !attempted && typeof file === "string" && file.endsWith("history.json.write-lock")) {
    attempted = true; process.send?.({type:"lock-attempt", role});
  }
  return origMkdir.call(fs, file, ...args);
};
let blocked = false;
fs.readFileSync = function(file, ...args) {
  const result = origRead.call(fs, file, ...args);
  if (role === 'owner' && !blocked && typeof file === 'string' && file.endsWith('history.json') && new Error().stack?.includes('writeRun')) {
    blocked = true;
    process.send?.({type:'barrier', role});
    waitFile(path.join(barrierDir, `${role}.release`));
  }
  return result;
};
syncBuiltinESMExports();
const { createScheduledRunManager } = await import('../../src/runs/background/scheduled-runs.ts');
const ctx = {cwd:project,sessionManager:{getSessionId:()=>role,getSessionFile:()=>path.join(project,`${role}.jsonl`)}};
let id = 0;
const manager = createScheduledRunManager({
  config:{scheduledRuns:{enabled:true}},storeRoot,now:()=>now,randomId:()=>`${role}-${++id}`,
  timers:{setTimeout:()=>1,clearTimeout:()=>{}},
  launch:async()=>({content:[],details:{asyncId:`${role}-async`}})
});
manager.bindSession(ctx);
process.send?.({type:'ready',role});
waitFile(path.join(barrierDir, `${role}.start`));
await manager.handleToolCall({action:'schedule.run',id:'check'},ctx);
process.send?.({type:'result',role});
manager.stop();
process.disconnect?.();
