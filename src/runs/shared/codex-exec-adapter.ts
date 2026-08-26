import * as fs from "node:fs";
import * as path from "node:path";
import { parseExternalCliJsonlEvent, type ExternalCliParser, type ExternalCliParserProgress, type ExternalCliParserTerminal } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";

const MAX_FINAL_MESSAGE_BYTES = 1024 * 1024;
const MAX_EVENT_TYPE_LENGTH = 128;

export const CODEX_EXEC_ADAPTER_ID = "codex-exec" as const;
export const CODEX_EXEC_WRITER_ADAPTER_ID = "codex-exec-writer" as const;
export const CODEX_EXEC_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"CODEX_HOME",
	"CODEX_API_KEY",
	"OPENAI_API_KEY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

function eventError(event: Record<string, unknown>, fallback: string): string {
	const error = event.error;
	if (typeof error === "string" && error.trim()) return error.trim().slice(0, 4_096);
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === "string" && message.trim()) return message.trim().slice(0, 4_096);
	}
	const message = event.message;
	return typeof message === "string" && message.trim() ? message.trim().slice(0, 4_096) : fallback;
}

export function createCodexExecJsonlParser(finalMessagePath: string): ExternalCliParser {
	let eventCount = 0;
	let terminal: ExternalCliParserTerminal | undefined;
	return {
		parseLine(line): ExternalCliParserProgress {
			const event = parseExternalCliJsonlEvent(line, "Codex exec", MAX_EVENT_TYPE_LENGTH);
			if (terminal) throw new Error("Codex exec emitted an event after its terminal state.");
			eventCount += 1;
			if (event.type === "turn.completed") terminal = { state: "completed" };
			else if (event.type === "turn.failed") terminal = { state: "failed", error: eventError(event, "Codex exec reported turn.failed.") };
			else if (event.type === "error") terminal = { state: "failed", error: eventError(event, "Codex exec reported an error event.") };
			return { phase: terminal ? terminal.state : "streaming", eventCount };
		},
		finish(): ExternalCliParserTerminal | undefined {
			if (!terminal || terminal.state === "failed") return terminal;
			let descriptor: number;
			try { descriptor = fs.openSync(finalMessagePath, "r"); }
			catch (error) { throw new Error(`Codex exec did not write its final-message artifact: ${error instanceof Error ? error.message : String(error)}`); }
			try {
				const stat = fs.fstatSync(descriptor);
				if (!stat.isFile()) throw new Error("Codex exec final-message artifact is not a file.");
				if (stat.size > MAX_FINAL_MESSAGE_BYTES) throw new Error("Codex exec final-message artifact exceeded its byte limit.");
				const content = Buffer.alloc(stat.size);
				let bytesRead = 0;
				while (bytesRead < content.length) {
					const count = fs.readSync(descriptor, content, bytesRead, content.length - bytesRead, bytesRead);
					if (count === 0) break;
					bytesRead += count;
				}
				const output = content.subarray(0, bytesRead).toString("utf-8").trim();
				if (!output) throw new Error("Codex exec final-message artifact is empty.");
				return { state: "completed", output };
			} finally { fs.closeSync(descriptor); }
		},
	};
}

export function resolveCodexExecLaunch(input: {
	adapter: typeof CODEX_EXEC_ADAPTER_ID | typeof CODEX_EXEC_WRITER_ADAPTER_ID;
	command: string;
	asyncDir: string;
	stepIndex: number;
	/** Test-only executable prefix for a fake Codex process. */
	commandPrefixArgs?: readonly string[];
}): {
	command: string;
	args: string[];
	finalOutputPath: string;
	promptFilePath?: undefined;
	temporaryDirectories?: undefined;
	environment: { allowlist: readonly string[] };
	preflight: ExternalCliPreflightSpec;
	parser: ExternalCliParser;
} {
	const writer = input.adapter === CODEX_EXEC_WRITER_ADAPTER_ID;
	const finalMessagePath = path.join(input.asyncDir, `external-${input.stepIndex}.final-message.txt`);
	fs.rmSync(finalMessagePath, { force: true });
	const prefix = [...(input.commandPrefixArgs ?? [])];
	const args = [
		...prefix,
		"exec",
		"--json",
		"--color", "never",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"-s", writer ? "workspace-write" : "read-only",
		"-c", 'approval_policy="never"',
		"--output-last-message", finalMessagePath,
		"-",
	];
	return {
		command: input.command,
		args,
		finalOutputPath: finalMessagePath,
		environment: { allowlist: CODEX_EXEC_ENV_ALLOWLIST },
		preflight: {
			id: input.adapter,
			versionArgs: [...prefix, "--version"],
			helpArgs: [...prefix, "exec", "--help"],
			validate(result) {
				if (!/^codex-cli \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(result.version)) throw new Error(`Unsupported Codex version response: ${JSON.stringify(result.version)}.`);
				for (const required of ["Run Codex non-interactively", "--json", "--output-last-message", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--sandbox", writer ? "workspace-write" : "read-only", "--config"]) {
					if (!result.help.includes(required)) throw new Error(`Codex exec help does not document required option ${JSON.stringify(required)}.`);
				}
			},
		},
		parser: createCodexExecJsonlParser(finalMessagePath),
	};
}
