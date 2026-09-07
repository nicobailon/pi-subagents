import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { runInspector } = await jiti.import("./src/inspectors/inspector-runner.ts");

try {
	runInspector();
} catch (cause) {
	process.stderr.write(`Inspector failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exitCode = 1;
}
