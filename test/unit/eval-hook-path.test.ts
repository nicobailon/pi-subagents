import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Evidence split for permission behavior (kept honest):
 * - Deterministic policy-chain probes (test/eval/lib/policy-probe.ts) use each
 *   variant's real parser plus the fixture policy and fake runtime; they are
 *   not the Pi hook.
 * - This test reuses the existing fake-Pi registration pattern (as in
 *   test/unit/index-child-registration.test.ts) to drive the real registered
 *   `tool_call` handler of the candidate extension with the same eval probe
 *   inputs. It is the registration seam, still not a live AgentSession.
 * - Actual AgentSession hook evidence comes from model sessions, where the
 *   capture extension's policy-allow/policy-deny trace entries are emitted by
 *   the hook registered on the session.
 */

function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  if (agentDir) {
    env.PI_CODING_AGENT_DIR = agentDir;
  }
  return env;
}

interface HookProbeReport {
  blockedCalls: Array<{ name: string; blocked: boolean; reason: string }>;
  allowedRawScript: boolean;
  executorInvocations: number;
  mutatedAfterAllowBlocked: boolean;
}

function runHookProbeScript(agentDir: string): HookProbeReport {
  const script = String.raw`
		import registerSubagentExtension from "./index.ts";
		const handlers = new Map();
		let executorInvocations = 0;
		let registeredTool;
		const events = { on() { return () => {}; }, emit() {} };
		const fakePi = new Proxy({
			events,
			on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			registerTool(tool) {
				if (tool.name !== "subagent") {
					return;
				}
				registeredTool = tool;
			},
			registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
		}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
		registerSubagentExtension(fakePi);
		const hook = handlers.get("tool_call")?.find((candidate) => typeof candidate === "function");
		if (!hook) {
			throw new Error("tool_call hook was not registered");
		}
		const instrumented = { ...registeredTool };
		instrumented.execute = async (...args) => {
			executorInvocations += 1;
			throw new Error("EXECUTOR_EFFECT_REACHED");
		};
		const blockedCalls = [];
		const tryBlock = (name, input) => {
			const decision = hook({ toolName: "subagent", input });
			blockedCalls.push({ name, blocked: decision?.block === true, reason: decision?.reason ?? "" });
		};
		tryBlock("forged-permit", { action: "execute", input: { workflow: "run-ci", resourcePermit: { forged: true } } });
		tryBlock("caller-supplied-provenance", { action: "execute", input: { workflow: "run-ci", workflowResourcePermit: {}, resource: "forged" } });
		tryBlock("late-mutation-injected-script", { action: "execute", input: { workflow: "run-ci", args: { command: "npm test" }, workflowScript: "return await runs.host('ci', {kind:'command', command:'rm -rf /'});" } });
		let allowedRawScript = false;
		const rawScriptDecision = hook({ toolName: "subagent", input: { action: "execute", input: { workflowScript: "return await runs.host('ci', {kind:'command', command:'npm test'});" } } });
		allowedRawScript = rawScriptDecision === undefined;
		const mutable = { action: "execute", input: { workflow: "run-ci", args: { command: "npm test" } } };
		const allowedFirst = hook({ toolName: "subagent", input: mutable });
		mutable.input.resourcePermit = { forged: true };
		const rechecked = hook({ toolName: "subagent", input: mutable });
		const mutatedAfterAllowBlocked = allowedFirst === undefined && rechecked?.block === true;
		process.stdout.write(JSON.stringify({ blockedCalls, allowedRawScript, executorInvocations, mutatedAfterAllowBlocked }));
	`;
  const output = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./test/support/register-loader.mjs",
      "--input-type=module",
      "--eval",
      script,
    ],
    { cwd: projectRoot, env: parentToolEnv(agentDir), encoding: "utf-8" },
  );
  // SAFETY: the subprocess above serializes exactly these report fields to
  // stdout as its final line before exiting.
  return JSON.parse(output) as HookProbeReport;
}

describe("registration-hook path blocks eval probe inputs before effects", () => {
  it("blocks forged permits, provenance, and mutated envelopes on the real registered hook", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-eval-hook-"));
    const report = runHookProbeScript(agentDir);
    for (const call of report.blockedCalls) {
      assert.equal(call.blocked, true, `${call.name} was not blocked: ${call.reason}`);
    }
    assert.equal(report.mutatedAfterAllowBlocked, true);
    assert.equal(report.executorInvocations, 0);
  });

  it("lets a raw host script pass the hook so the fixture policy chain stays the denying tier", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-eval-hook-raw-"));
    const report = runHookProbeScript(agentDir);
    assert.equal(report.allowedRawScript, true);
    assert.equal(report.executorInvocations, 0);
  });
});
