import fs from "node:fs";
import path from "node:path";

const queueDir = process.env.MOCK_PI_QUEUE_DIR;

function fail(message, exitCode = 1) {
	process.stderr.write(`${message}\n`);
	process.exit(exitCode);
}

function listPendingFiles(dir) {
	return fs.readdirSync(dir)
		.filter((name) => name.startsWith("pending-") && name.endsWith(".json"))
		.sort();
}

function claimNextResponse(dir) {
	for (const fileName of listPendingFiles(dir)) {
		const sourcePath = path.join(dir, fileName);
		const targetPath = path.join(dir, fileName.replace(/^pending-/, "consumed-"));
		try {
			fs.renameSync(sourcePath, targetPath);
			return JSON.parse(fs.readFileSync(targetPath, "utf-8"));
		} catch (error) {
			if (error && typeof error === "object" && "code" in error) {
				const code = error.code;
				if (code === "ENOENT" || code === "EEXIST") continue;
			}
			throw error;
		}
	}

	const defaultPath = path.join(dir, "default-response.json");
	if (!fs.existsSync(defaultPath)) return undefined;
	return JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
}

function defaultAssistantMessage(output) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
			model: "mock/test-model",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.001 },
			},
		},
	};
}

function defaultResponse() {
	return { output: "ok", exitCode: 0 };
}

function isJsonMode(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--mode") {
			return args[i + 1] === "json";
		}
	}
	return false;
}

function writeJsonlLine(entry) {
	const line = typeof entry === "string" ? entry : JSON.stringify(entry);
	process.stdout.write(`${line}\n`);
}

function extractPlainText(entry) {
	if (!entry || typeof entry !== "object") return "";
	if (entry.type === "message_end") {
		const text = entry.message?.content?.find?.((part) => part?.type === "text")?.text;
		return typeof text === "string" ? text : "";
	}
	if (entry.type === "tool_result_end") {
		const text = entry.message?.content?.find?.((part) => part?.type === "text")?.text;
		return typeof text === "string" ? text : "";
	}
	return "";
}

function writeResponseEntries(entries, jsonMode) {
	for (const entry of entries) {
		if (jsonMode) {
			writeJsonlLine(entry);
			continue;
		}
		const text = extractPlainText(entry);
		if (text) process.stdout.write(`${text}\n`);
	}
}

async function main() {
	if (!queueDir) fail("MOCK_PI_QUEUE_DIR is required.");
	if (!fs.existsSync(queueDir)) fail(`Mock queue dir does not exist: ${queueDir}`);

	const jsonMode = isJsonMode(process.argv.slice(2));
	const response = claimNextResponse(queueDir) ?? defaultResponse();
	fs.writeFileSync(
		path.join(queueDir, `call-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`),
		JSON.stringify({ args: process.argv.slice(2) }),
		"utf-8",
	);

	if (typeof response.delay === "number" && response.delay > 0) {
		await new Promise((resolve) => setTimeout(resolve, response.delay));
	}

	if (Array.isArray(response.steps) && response.steps.length > 0) {
		for (const step of response.steps) {
			if (typeof step?.delay === "number" && step.delay > 0) {
				await new Promise((resolve) => setTimeout(resolve, step.delay));
			}
			if (Array.isArray(step?.jsonl) && step.jsonl.length > 0) {
				writeResponseEntries(step.jsonl, jsonMode);
			}
			if (typeof step?.stderr === "string" && step.stderr.length > 0) {
				process.stderr.write(step.stderr);
			}
		}
	} else if (Array.isArray(response.jsonl) && response.jsonl.length > 0) {
		writeResponseEntries(response.jsonl, jsonMode);
	} else if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
		const envSnapshot = Object.fromEntries(response.echoEnv.map((key) => [key, process.env[key] ?? null]));
		if (jsonMode) writeJsonlLine(defaultAssistantMessage(JSON.stringify(envSnapshot)));
		else process.stdout.write(`${JSON.stringify(envSnapshot)}\n`);
	} else if (typeof response.output === "string") {
		if (jsonMode) writeJsonlLine(defaultAssistantMessage(response.output));
		else process.stdout.write(`${response.output}\n`);
	}

	if (typeof response.stderr === "string" && response.stderr.length > 0) {
		process.stderr.write(response.stderr);
	}

	process.exit(typeof response.exitCode === "number" ? response.exitCode : 0);
}

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
