import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createDefaultChildSessionFactory, setChildSessionFactory } from "../../src/runs/shared/child-session.ts";
import { DIRS } from "../../src/shared/types.ts";
import { makeAgent } from "../support/helpers.ts";

it("native reviewer consumes nested persona results via exact, prefix, and aggregate waits", {
	skip: !process.env.PI_SUBAGENTS_NATIVE_PI_ROOT && "Requires PI_SUBAGENTS_NATIVE_PI_ROOT and native-peer-loader.mjs",
	timeout: 60000,
}, async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-nested-wait-"));
	const agentDir = path.join(root, "agent");
	const auditPath = path.join(root, "audit.jsonl");
	const savedEnv = { ...process.env };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.PI_SUBAGENTS_NATIVE_WAIT_AUDIT = auditPath;
	const extension = fileURLToPath(new URL("../fixtures/native-nested-wait-provider.ts", import.meta.url));
	fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }));
	for (const name of ["arm-a", "arm-b", "persona"]) {
		fs.writeFileSync(path.join(agentDir, "agents", `${name}.md`), [
			"---", `name: ${name}`, "description: Native nested wait test", `model: nested-wait-fixture/${name}`,
			`tools: ${name === "persona" ? "read" : "read, subagent, bg_wait"}`, `extensions: ${extension}`,
			"inheritGlobalContext: false", "inheritProjectContext: false", "inheritSkills: false", "acceptanceRole: read-only", "---", "Complete only the fixture task.",
		].join("\n"));
	}
	const factory = createDefaultChildSessionFactory();
	setChildSessionFactory(factory);
	try {
		const reviewer = makeAgent("reviewer", { model: "nested-wait-fixture/reviewer", tools: ["read", "subagent", "bg_wait"], extensions: [extension], inheritGlobalContext: false, inheritProjectContext: false, inheritSkills: false });
		const result = await runSync(root, [reviewer], "reviewer", "Review using the two assigned arms", {
			runId: "native-nested-wait", sessionDir: path.join(root, "sessions"), share: true, maxSubagentDepth: 4,
			timeoutMs: 45000, waitToolDefaultTimeoutMs: 25000, childSessionFactory: factory,
		});
		assert.equal(result.exitCode, 0, `${result.error}\nAudit: ${fs.readFileSync(auditPath, "utf8")}`);
		assert.equal(result.finalOutput, "CONSUMED_reviewer: PERSONA_EVIDENCE");
		const audit = fs.readFileSync(auditPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		for (const model of ["reviewer", "arm-a", "arm-b"]) {
			assert.ok(audit.some((entry) => entry.model === model && entry.content.some((part: { text?: string }) => part.text === `CONSUMED_${model}: PERSONA_EVIDENCE`)), `${model} must actually read and consume its descendants' findings`);
			const readPaths: string[] = audit.filter((entry) => entry.model === model).flatMap((entry) => entry.content.filter((part: { name?: string }) => part.name === "read").map((part: { arguments: { path: string } }) => part.arguments.path));
			assert.equal(readPaths.length, model === "arm-a" ? 2 : 1);
			for (const file of readPaths) {
				assert.ok(fs.existsSync(file));
				assert.equal(file.startsWith(path.join(DIRS.results, "nested") + path.sep), model !== "reviewer", "ordinary workflow and nested result namespaces are both exercised");
			}
		}
	} finally {
		await factory.dispose();
		setChildSessionFactory(undefined);
		for (const key of ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SUBAGENTS_NATIVE_WAIT_AUDIT"]) {
			if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});
