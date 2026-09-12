import { withHerdrPaneAllocationLock } from "../../src/runs/shared/herdr-placed-run.ts";

const [encodedKey, holdText, timeoutText] = process.argv.slice(2);
const key = Buffer.from(encodedKey!, "base64url").toString("utf8");
const holdMs = Number(holdText);
const timeoutMs = Number(timeoutText);
try {
	await withHerdrPaneAllocationLock(key!, async () => {
		process.stdout.write("locked\n");
		await new Promise((resolve) => setTimeout(resolve, holdMs));
	}, { timeoutMs, pollMs: 10 });
	process.stdout.write("released\n");
} catch (error) {
	process.stderr.write(error instanceof Error ? error.message : String(error));
	process.exitCode = 2;
}
