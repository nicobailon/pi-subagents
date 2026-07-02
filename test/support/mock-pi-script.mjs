import fs from "node:fs";
import path from "node:path";

const queueDir = process.env.MOCK_PI_QUEUE_DIR;

function exitAfterFlush(code) {
	// process.exit() can truncate buffered stdout/stderr on slow runners (e.g.
	// GitHub Actions), dropping the final lines the parent executor needs to see
	// the run as successful. Drain the writable streams first, then exit.
	// A hard timeout (ref'd, not unref'd) guards against stream.end() callbacks
	// that never fire on some platforms (notably Windows pipe-backed stdout).
	const streams = [process.stdout, process.stderr].filter((s) => !s.destroyed && !s.writableEnded);
	if (streams.length === 0) {
		process.exit(code);
		return;
	}
	let exited = false;
	const forceExit = () => {
		if (exited) return;
		exited = true;
		process.exit(code);
	};
	let pending = streams.length;
	for (const stream of streams) {
		stream.end(() => {
			if (--pending === 0) forceExit();
		});
	}
	setTimeout(forceExit, 500);
}

function fail(message, exitCode = 1) {
	process.stderr.write(`${message}\n`);
	exitAfterFlush(exitCode);
}

function listPendingFiles(dir) {
	return fs.readdirSync(dir)
		.filter((name) => name.startsWith("pending-") && name.endsWith(".json"))
		.sort();
}

function readPendingResponse(filePath) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) {
			const code = error.code;
			if (code === "ENOENT") return undefined;
		}
		throw error;
	}
}

function hasArgMatcher(response) {
	return Object.prototype.hasOwnProperty.call(response ?? {}, "matchArgIncludes");
}

function responseMatchesArgs(response, args) {
	const matcher = response?.matchArgIncludes;
	if (matcher === undefined) return true;
	const needles = Array.isArray(matcher) ? matcher : [matcher];
	if (needles.length === 0) return true;
	const haystack = args.join("\n");
	return needles.every((needle) => typeof needle === "string" && haystack.includes(needle));
}

function claimResponseFile(dir, fileName) {
	const sourcePath = path.join(dir, fileName);
	const targetPath = path.join(dir, fileName.replace(/^pending-/, "consumed-"));
	try {
		fs.renameSync(sourcePath, targetPath);
		return JSON.parse(fs.readFileSync(targetPath, "utf-8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) {
			const code = error.code;
			if (code === "ENOENT" || code === "EEXIST" || code === "EPERM") return undefined;
		}
		throw error;
	}
}

function claimNextResponse(dir, args) {
	for (const fileName of listPendingFiles(dir)) {
		const sourcePath = path.join(dir, fileName);
		const response = readPendingResponse(sourcePath);
		if (!response || !hasArgMatcher(response) || !responseMatchesArgs(response, args)) continue;
		const claimed = claimResponseFile(dir, fileName);
		if (claimed) return claimed;
	}

	for (const fileName of listPendingFiles(dir)) {
		const sourcePath = path.join(dir, fileName);
		const response = readPendingResponse(sourcePath);
		if (!response || hasArgMatcher(response)) continue;
		const claimed = claimResponseFile(dir, fileName);
		if (claimed) return claimed;
	}

	const defaultPath = path.join(dir, "default-response.json");
	if (!fs.existsSync(defaultPath)) return undefined;
	const fallback = JSON.parse(fs.readFileSync(defaultPath, "utf-8"));
	return responseMatchesArgs(fallback, args) ? fallback : undefined;
}

function defaultAssistantMessage(output) {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: output }],
			model: "mock/test-model",
			stopReason: "stop",
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

function taskRequestsAcceptance(args) {
	for (const arg of args) {
		if (typeof arg !== "string") continue;
		if (arg.includes("## Acceptance Contract")) return true;
		if (!arg.startsWith("@")) continue;
		try {
			if (fs.readFileSync(arg.slice(1), "utf-8").includes("## Acceptance Contract")) return true;
		} catch {
			// Ignore unreadable temp prompt references in the mock harness.
		}
	}
	return false;
}

function defaultAcceptanceReport() {
	return [
		"```acceptance-report",
		JSON.stringify({
			criteriaSatisfied: [
				{ id: "criterion-1", status: "satisfied", evidence: "mock acceptance evidence" },
				{ id: "criterion-2", status: "satisfied", evidence: "mock acceptance evidence" },
			],
			changedFiles: ["mock-file.ts"],
			testsAddedOrUpdated: ["mock-file.test.ts"],
			commandsRun: [{ command: "mock validation", result: "passed", summary: "passed" }],
			validationOutput: ["mock validation passed"],
			residualRisks: [],
			noStagedFiles: true,
			reviewFindings: [],
			manualNotes: "mock run completed",
			notes: "mock run completed",
		}),
		"```",
	].join("\n");
}

function withAcceptanceReport(output, args) {
	if (!taskRequestsAcceptance(args) || output.includes("```acceptance-report")) return output;
	return `${output}\n${defaultAcceptanceReport()}`;
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

function writeSessionFile(args) {
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--session") continue;
		const sessionFile = args[i + 1];
		if (!sessionFile) return;
		fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
		fs.writeFileSync(sessionFile, "", { flag: "a" });
		return;
	}
}

function readSystemPromptRecords(args) {
	const records = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== "--system-prompt" && args[i] !== "--append-system-prompt") continue;
		const promptPath = args[i + 1];
		if (!promptPath) continue;
		try {
			records.push({
				mode: args[i],
				path: promptPath,
				text: fs.readFileSync(promptPath, "utf-8"),
			});
		} catch (error) {
			records.push({
				mode: args[i],
				path: promptPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return records;
}

async function writeStdout(text) {
	if (process.stdout.write(text)) return;
	await new Promise((resolve) => process.stdout.once("drain", resolve));
}

async function writeJsonlLine(entry) {
	const line = typeof entry === "string" ? entry : JSON.stringify(entry);
	await writeStdout(`${line}\n`);
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

async function writeResponseEntries(entries, jsonMode, args) {
	let sawProviderError = false;
	for (const entry of entries) {
		if (entry?.type === "message_end") {
			const textPart = entry.message?.content?.find?.((part) => part?.type === "text");
			const isProviderError = Boolean(entry.message?.errorMessage || entry.message?.stopReason === "error");
			if (isProviderError) sawProviderError = true;
			if (!isProviderError && textPart && typeof textPart.text === "string" && (!sawProviderError || textPart.text.trim())) {
				textPart.text = withAcceptanceReport(textPart.text, args);
			}
		}
		if (jsonMode) {
			await writeJsonlLine(entry);
			continue;
		}
		const text = extractPlainText(entry);
		if (text) await writeStdout(`${text}\n`);
	}
}

async function maybeWriteStructuredOutput(response, jsonMode) {
	if (!Object.prototype.hasOwnProperty.call(response, "structuredOutput")) return;
	const outputPath = process.env.PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE;
	if (!outputPath) return;
	fs.mkdirSync(path.dirname(outputPath), { recursive: true });
	fs.writeFileSync(outputPath, JSON.stringify(response.structuredOutput), "utf-8");
	if (!jsonMode) return;
	await writeJsonlLine({ type: "tool_execution_start", toolName: "structured_output", args: { value: response.structuredOutput } });
	await writeJsonlLine({
		type: "tool_result_end",
		message: {
			role: "toolResult",
			toolName: "structured_output",
			content: [{ type: "text", text: "Structured output captured." }],
		},
	});
	await writeJsonlLine({ type: "tool_execution_end", toolName: "structured_output" });
}

async function main() {
	if (!queueDir) fail("MOCK_PI_QUEUE_DIR is required.");
	if (!fs.existsSync(queueDir)) fail(`Mock queue dir does not exist: ${queueDir}`);

	const args = process.argv.slice(2);
	const jsonMode = isJsonMode(args);
	const response = claimNextResponse(queueDir, args) ?? defaultResponse();
	if (response.ignoreSigterm === true) {
		process.on("SIGTERM", () => {});
	}
	writeSessionFile(args);
	fs.writeFileSync(
		path.join(queueDir, `call-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.json`),
		JSON.stringify({ args, systemPrompts: readSystemPromptRecords(args) }),
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
						await writeResponseEntries(step.jsonl, jsonMode, args);
				}
				if (typeof step?.stderr === "string" && step.stderr.length > 0) {
					process.stderr.write(step.stderr);
				}
			}
		} else if (Array.isArray(response.jsonl) && response.jsonl.length > 0) {
				await writeResponseEntries(response.jsonl, jsonMode, args);
		} else if (Array.isArray(response.echoEnv) && response.echoEnv.length > 0) {
			const envSnapshot = Object.fromEntries(response.echoEnv.map((key) => [key, process.env[key] ?? null]));
				const output = withAcceptanceReport(JSON.stringify(envSnapshot), args);
				if (jsonMode) await writeJsonlLine(defaultAssistantMessage(output));
				else await writeStdout(`${output}\n`);
			} else if (typeof response.output === "string") {
				const output = withAcceptanceReport(response.output, args);
				if (jsonMode) await writeJsonlLine(defaultAssistantMessage(output));
				else await writeStdout(`${output}\n`);
			}
		await maybeWriteStructuredOutput(response, jsonMode);

	if (typeof response.stderr === "string" && response.stderr.length > 0) {
		process.stderr.write(response.stderr);
	}

	if (typeof response.keepAliveAfterFinalMessageMs === "number" && response.keepAliveAfterFinalMessageMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, response.keepAliveAfterFinalMessageMs));
	}

	exitAfterFlush(typeof response.exitCode === "number" ? response.exitCode : 0);
}

main().catch((error) => {
	fail(error instanceof Error ? error.message : String(error));
});
