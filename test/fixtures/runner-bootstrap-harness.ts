import { runConfiguredSubagent } from "../../src/runs/background/subagent-runner-bootstrap.ts";

const config = JSON.parse(process.argv[2] ?? "null") as unknown;
const mode = process.argv[3];
let importRequested = false;

process.on("message", (message) => {
	if (message === "probe") process.send?.({ type: "probe-result", importRequested });
});

try {
	await runConfiguredSubagent(config, {
		loadExecutionModule: async () => {
			importRequested = true;
			process.send?.({ type: "import-requested" });
			await new Promise<void>((resolve) => {
				const listener = (message: unknown) => {
					if (message !== "release-import") return;
					process.off("message", listener);
					resolve();
				};
				process.on("message", listener);
			});
			if (mode === "reject") throw new Error("injected heavy import rejection");
			return {
				async runConfiguredSubagentExecution(executionConfig) {
					process.send?.({ type: "executed", token: executionConfig.revivalLeaseToken });
				},
			};
		},
	});
	process.exit(0);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
