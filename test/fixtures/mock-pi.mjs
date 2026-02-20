#!/usr/bin/env node
/**
 * Mock pi CLI for integration tests.
 *
 * Simulates `pi --mode json -p` by outputting JSONL events to stdout.
 * Behavior is controlled via environment variables:
 *
 *   MOCK_PI_OUTPUT      — assistant text output (default: echo task)
 *   MOCK_PI_EXIT_CODE   — process exit code (default: 0)
 *   MOCK_PI_STDERR      — write to stderr before exiting
 *   MOCK_PI_DELAY_MS    — delay before responding (default: 0)
 *   MOCK_PI_JSONL       — JSON-encoded array of raw JSONL event objects
 *   MOCK_PI_WRITE_FILE  — "path:::content" — write content to path before exit
 *   MOCK_PI_WRITE_FILES — JSON-encoded array of {path, content} to write
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Parse CLI arguments (matches what execution.ts passes to pi)
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let task = "";
let sessionDir = null;

let i = 0;
while (i < args.length) {
	const arg = args[i];

	// Flags with a value — skip the value
	if (
		arg === "--session-dir" ||
		arg === "--mode" ||
		arg === "--models" ||
		arg === "--tools" ||
		arg === "--extension" ||
		arg === "--append-system-prompt"
	) {
		if (arg === "--session-dir") sessionDir = args[i + 1] ?? null;
		i += 2;
		continue;
	}

	// Flags without a value
	if (arg === "-p" || arg === "--no-session" || arg === "--no-extensions") {
		i++;
		continue;
	}

	// @file — read task from file
	if (arg?.startsWith("@")) {
		try {
			task = fs.readFileSync(arg.slice(1), "utf-8");
		} catch {
			task = `(could not read ${arg.slice(1)})`;
		}
		i++;
		continue;
	}

	// Positional — treat as task text
	if (arg && !arg.startsWith("-")) {
		task = arg;
	}
	i++;
}

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const exitCode = parseInt(process.env.MOCK_PI_EXIT_CODE || "0", 10);
const customOutput = process.env.MOCK_PI_OUTPUT;
const stderrMsg = process.env.MOCK_PI_STDERR;
const delayMs = parseInt(process.env.MOCK_PI_DELAY_MS || "0", 10);
const customJsonl = process.env.MOCK_PI_JSONL;

// ---------------------------------------------------------------------------
// Delay
// ---------------------------------------------------------------------------
if (delayMs > 0) {
	await new Promise((r) => setTimeout(r, delayMs));
}

// ---------------------------------------------------------------------------
// Stderr
// ---------------------------------------------------------------------------
if (stderrMsg) {
	process.stderr.write(stderrMsg + "\n");
}

// ---------------------------------------------------------------------------
// Write files (for chain_dir output simulation)
// ---------------------------------------------------------------------------
if (process.env.MOCK_PI_WRITE_FILE) {
	const sep = process.env.MOCK_PI_WRITE_FILE.indexOf(":::");
	if (sep !== -1) {
		const filePath = process.env.MOCK_PI_WRITE_FILE.slice(0, sep);
		const content = process.env.MOCK_PI_WRITE_FILE.slice(sep + 3);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
	}
}

if (process.env.MOCK_PI_WRITE_FILES) {
	try {
		const files = JSON.parse(process.env.MOCK_PI_WRITE_FILES);
		for (const { path: filePath, content } of files) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, content);
		}
	} catch {}
}

// ---------------------------------------------------------------------------
// JSONL output
// ---------------------------------------------------------------------------
if (customJsonl) {
	const events = JSON.parse(customJsonl);
	for (const event of events) {
		console.log(typeof event === "string" ? event : JSON.stringify(event));
	}
} else {
	const output = customOutput ?? `Mock output for: ${task.replace(/^Task:\s*/i, "").slice(0, 500)}`;
	console.log(
		JSON.stringify({
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
		}),
	);
}

// ---------------------------------------------------------------------------
// Session file (if requested)
// ---------------------------------------------------------------------------
if (sessionDir) {
	fs.mkdirSync(sessionDir, { recursive: true });
	fs.writeFileSync(
		path.join(sessionDir, `session-${Date.now()}.jsonl`),
		JSON.stringify({ type: "session_start" }) + "\n",
	);
}

process.exit(exitCode);
