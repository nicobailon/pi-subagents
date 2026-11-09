"use strict";

const { Worker } = require("node:worker_threads");
const { join } = require("node:path");

// Windows process creation adds a standard environment even when fork receives an empty one.
for (const key of Object.keys(process.env)) {
  if (process.platform !== "win32" || key.toLowerCase() !== "systemroot") delete process.env[key];
}

// Keep IPC on this thread: a busy workflow must not prevent parent-disconnect cleanup.
// The script thread has no worker permission; filesystem grants are inherited from the process.
const worker = new Worker(join(__dirname, "workflow-script-worker.cjs"), {
  workerData: { acornPath: process.argv[2] },
  execArgv: process.execArgv.filter((arg) => arg !== "--allow-worker"),
});

function fail(error) {
  if (!process.connected) return process.exit(1);
  process.send(JSON.stringify({ type: "error", errorKind: "runtime", error: String(error?.message ?? error) }), () => process.exit(1));
}

process.on("disconnect", () => process.exit(0));
process.on("message", (json) => {
  try {
    if (typeof json !== "string") throw new Error("Workflow process received a non-string IPC message.");
    worker.postMessage(JSON.parse(json));
  } catch (error) { fail(error); }
});
worker.on("message", (message) => {
  try {
    process.send(JSON.stringify(message), (error) => { if (error) process.exit(1); });
  } catch (error) { fail(error); }
});
worker.on("error", fail);
worker.on("exit", (code) => fail(new Error(`Workflow script thread exited before returning a result (code ${code}).`)));
