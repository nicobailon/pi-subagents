import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

test("ordinary prompt audit works without optional Pi peers", async () => {
	const isolatedRoot = await mkdtemp(join(tmpdir(), "pi-subagents-prompt-audit-"));
	const promptAuditPath = join(isolatedRoot, "src/runs/foreground/prompt-audit.ts");
	const streamOptionsPath = join(isolatedRoot, "src/shared/agent-stream-options.ts");

	try {
		await mkdir(dirname(promptAuditPath), { recursive: true });
		await mkdir(dirname(streamOptionsPath), { recursive: true });
		await writeFile(
			promptAuditPath,
			await readFile(join(repositoryRoot, "src/runs/foreground/prompt-audit.ts"), "utf8"),
		);
		await writeFile(
			streamOptionsPath,
			await readFile(join(repositoryRoot, "src/shared/agent-stream-options.ts"), "utf8"),
		);

		const promptAudit = await import(pathToFileURL(promptAuditPath).href);
		const control = {};
		promptAudit.registerLivePromptAudit(control, 0, "authored", "before authored after");
		assert.deepEqual(promptAudit.getLivePromptAudit(control, 0), {
			authoredTask: "authored",
			runtimeAdditions: "before\n\nafter",
			finalEffectivePrompt: "before authored after",
		});

		promptAudit.updateLiveEffectivePrompt(control, 0, "next authored tail");
		assert.equal(promptAudit.getLivePromptAudit(control, 0)?.runtimeAdditions, "next\n\ntail");
		promptAudit.removeLivePromptAudit(control, 0);
		assert.equal(promptAudit.getLivePromptAudit(control, 0), undefined);
	} finally {
		await rm(isolatedRoot, { recursive: true, force: true });
	}
});
