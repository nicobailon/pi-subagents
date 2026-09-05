import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { describe, it } from "node:test";
import { makeAgent } from "../support/helpers.ts";
import type { MockPiResponse } from "../support/mock-pi.ts";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { createStructuredOutputRuntime } from "../../src/runs/shared/structured-output.ts";
import type { JsonSchemaObject } from "../../src/shared/types.ts";
import {
	available,
	executeAsyncSingle,
	installAsyncExecutionHooks,
	isAsyncAvailable,
	mockPi,
	readAsyncPayload,
	tempDir,
} from "../support/async-execution-fixture.ts";

const providerError = "provider transport failed";
const structuredValue = { verdict: "ready" };
const structuredSchema: JsonSchemaObject = {
	type: "object",
	properties: { verdict: { const: "ready" } },
	required: ["verdict"],
	additionalProperties: false,
};
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };

type Host = "background" | "foreground";

function assistantMessage(stopReason: string, content: unknown[] = [], errorMessage?: string) {
	const message = {
		role: "assistant",
		content,
		model: "mock/test-model",
		stopReason,
		usage,
	};
	if (!errorMessage) return { type: "message_end", message };
	return { type: "message_end", message: { ...message, errorMessage } };
}

function toolCall(name = "read") {
	return { type: "toolCall", id: `${name}-call`, name, arguments: name === "structured_output" ? { value: structuredValue } : {} };
}

function failedAssistantRequest() {
	return assistantMessage("error", [], providerError);
}

interface FixtureResult {
	success: boolean;
	error?: string;
	structuredOutput?: unknown;
}

async function runFixture(host: Host, response: MockPiResponse, withStructuredOutput = false): Promise<FixtureResult> {
	mockPi.onCall(response);
	const agent = makeAgent("recovery-fixture", { completionGuard: false });
	const runId = `recovered-assistant-error-${host}-${randomUUID()}`;

	if (host === "foreground") {
		const structuredOutput = withStructuredOutput ? createStructuredOutputRuntime(structuredSchema, tempDir) : undefined;
		const options = { runId, acceptance: false as const, waitToolEnabled: false };
		const result = structuredOutput
			? await runSync(tempDir, [agent], agent.name, "Exercise the scripted child lifecycle", { ...options, structuredOutput })
			: await runSync(tempDir, [agent], agent.name, "Exercise the scripted child lifecycle", options);
		assert.equal(mockPi.callCount(), 1, "the fixture must not launch a fallback child");
		return { success: result.exitCode === 0, error: result.error, structuredOutput: result.structuredOutput };
	}

	const params = {
		agent: agent.name,
		task: "Exercise the scripted child lifecycle",
		agentConfig: agent,
		ctx: { pi: { events: { emit() {} } }, cwd: tempDir, currentSessionId: "recovered-assistant-error-session" },
		artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
		shareEnabled: false,
		sessionRoot: path.join(tempDir, "sessions"),
		maxSubagentDepth: 2,
		waitToolEnabled: false,
		acceptance: false as const,
	};
	const launch = withStructuredOutput
		? executeAsyncSingle(runId, { ...params, structuredOutputSchema: structuredSchema })
		: executeAsyncSingle(runId, params);
	assert.equal(launch.isError, undefined, launch.content[0]?.text ?? "background launch failed");
	const payload = await readAsyncPayload(runId);
	assert.equal(mockPi.callCount(), 1, "the fixture must not launch a fallback child");
	return {
		success: payload.success,
		error: payload.results[0]?.error,
		structuredOutput: payload.results[0]?.structuredOutput,
	};
}

// These cases use only the installed scripted ChildSessionFactory. They do not
// load a provider, credential, ambient extension, or real child agent.
describe("recovered assistant errors", { skip: !available ? "pi packages not available" : undefined }, () => {
	installAsyncExecutionHooks();

	for (const host of ["background", "foreground"] as const) {
		it(`${host}: recovered request can terminate with structured_output`, { skip: host === "background" && !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			const result = await runFixture(host, {
				jsonl: [
					failedAssistantRequest(),
					{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: providerError },
					assistantMessage("toolUse", [toolCall("structured_output")]),
					{ type: "auto_retry_end", success: true, attempt: 1 },
				],
				structuredOutput: structuredValue,
			}, true);

			assert.equal(result.success, true, result.error);
			assert.equal(result.error, undefined);
			assert.deepEqual(result.structuredOutput, structuredValue);
		});

		it(`${host}: retry success and toolUse without a call do not clear the error`, { skip: host === "background" && !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			const result = await runFixture(host, {
				jsonl: [
					failedAssistantRequest(),
					{ type: "auto_retry_end", success: true, attempt: 1 },
					assistantMessage("toolUse"),
				],
			});

			assert.equal(result.success, false);
			assert.match(result.error ?? "", new RegExp(providerError));
		});

		it(`${host}: a tool call with a non-toolUse stop does not clear the error`, { skip: host === "background" && !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			const result = await runFixture(host, {
				jsonl: [failedAssistantRequest(), assistantMessage("length", [toolCall()])],
			});

			assert.equal(result.success, false);
			assert.match(result.error ?? "", new RegExp(providerError));
		});

		it(`${host}: an error-bearing toolUse response replaces rather than clears the error`, { skip: host === "background" && !isAsyncAvailable() ? "jiti not available" : undefined }, async () => {
			const result = await runFixture(host, {
				jsonl: [failedAssistantRequest(), assistantMessage("toolUse", [toolCall()], "later provider failure")],
			});

			assert.equal(result.success, false);
			assert.match(result.error ?? "", /later provider failure/);
		});
	}
});
