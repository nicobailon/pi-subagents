import { type ChildProcess, type ChildProcessByStdio, type SpawnOptions, type SpawnOptionsWithStdioTuple, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns, type StdioNull, type StdioPipe } from "node:child_process";
import type { Readable } from "node:stream";
export declare function spawnProcess(command: string, args: string[], options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>): ChildProcessByStdio<null, Readable, Readable>;
export declare function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export declare function spawnProcessSync(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * A short-lived child can `exit` while a detached descendant keeps its stdout/stderr
 * pipe open. We must not resolve and destroy the streams on a fixed deadline measured
 * from `exit`, or output still being written past that deadline is silently lost
 * (earendil-works/pi#5303). Instead, after `exit` we wait for the pipes to fall idle:
 * the grace timer is re-armed on every chunk, so an actively writing descendant keeps
 * us reading, while a quiet inherited handle (e.g. a Windows daemonized descendant
 * that never lets `close` fire) still releases us after the grace elapses.
 */
export declare function waitForChildProcess(child: ChildProcess): Promise<number | null>;
//# sourceMappingURL=child-process.d.ts.map