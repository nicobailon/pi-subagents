const controller = new AbortController();
process.on("message", (message) => { if (message && typeof message === "object" && "type" in message && message.type === "cancel") controller.abort(); });
process.on("disconnect", () => controller.abort());
process.on("SIGTERM", () => controller.abort());
const input = JSON.parse(process.argv[2] ?? "{}");
try {
	const { enforceWorktreeRetainCount } = await import("./worktree-count-policy.ts");
	const terminal = new Set<string>(input.terminalForegroundRunIds ?? []);
	const report = await enforceWorktreeRetainCount({ ...input, signal: controller.signal, foregroundRunOwnership: (runId) => terminal.has(runId) ? "terminal" : "unknown" });
	process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
} finally {
	if (process.connected) process.disconnect();
}
