import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SUBAGENT_COMMAND_TOOL_DESCRIPTION } from "../../src/extension/tool-description.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/child-runtime-config.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parentToolEnv(agentDir?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[SUBAGENT_CHILD_ENV];
  if (agentDir) {
    env.PI_CODING_AGENT_DIR = agentDir;
  }
  return env;
}

function readRegisteredTool(agentDir: string): {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  properties: string[];
  required: string[];
} {
  const script = String.raw`
		import registerSubagentExtension from "./src/extension/index.ts";
		const events = { on() { return () => {}; }, emit() {} };
		let registeredTool;
		const fakePi = new Proxy({
			events,
			registerTool(tool) {
				if (tool.name === "subagent") {
					registeredTool = tool;
				}
			},
			registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, getSessionName() {},
		}, { get(target, prop) { return prop in target ? target[prop] : () => undefined; } });
		registerSubagentExtension(fakePi);
		if (!registeredTool) {
			throw new Error("tool not registered");
		}
		process.stdout.write(JSON.stringify({
			description: registeredTool.description,
			promptSnippet: registeredTool.promptSnippet,
			promptGuidelines: registeredTool.promptGuidelines,
			properties: Object.keys(registeredTool.parameters.properties),
			required: registeredTool.parameters.required,
		}));
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
  // SAFETY: the subprocess serializes exactly these selected registered-tool fields immediately above.
  return JSON.parse(output) as {
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    properties: string[];
    required: string[];
  };
}

describe("registered subagent command description", () => {
  it("uses one unconditional compact catalog description", () => {
    assert.match(
      SUBAGENT_COMMAND_TOOL_DESCRIPTION,
      /Before launching.*\{action:'list',input:\{capabilities:true\}\}/,
    );
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /async:false.*current turn/);
    assert.match(
      SUBAGENT_COMMAND_TOOL_DESCRIPTION,
      /Multi-child, parallel, conditional, or dependent.*requires.*workflowScript/,
    );
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /validate checks.*without running/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /status reads.*zero-based index.*lines/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /stop takes id.*childId/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /\{workflow:'<name>',args:\{\.\.\.\}\}/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /topic:'contract:<action>'.*when needed/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /topic:'workflows'.*once/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /results\/output are terminal/);
    assert.match(
      SUBAGENT_COMMAND_TOOL_DESCRIPTION,
      /successful management or control response.*answer.*unless.*verification/,
    );
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /children\.list finds resumable children/);
    assert.match(SUBAGENT_COMMAND_TOOL_DESCRIPTION, /resume take[s]? id,message/);
    assert.ok(SUBAGENT_COMMAND_TOOL_DESCRIPTION.split(/\s+/).length <= 350);
    assert.match(
      SUBAGENT_COMMAND_TOOL_DESCRIPTION,
      /Named workflows resolve host-owned authority; raw scripts cannot gain it/,
    );
    assert.match(
      SUBAGENT_COMMAND_TOOL_DESCRIPTION,
      /Honor the requested launch form exactly; never turn requested host execution into a child task.*If that form is denied, report the denial; do not substitute/,
    );
    assert.doesNotMatch(
      SUBAGENT_COMMAND_TOOL_DESCRIPTION,
      /omit action|toolDescriptionMode|subagent-tool-description/,
    );
  });

  it("keeps evaluation fixture answers out of the published description", () => {
    const fixtureSpecificTokens = [
      "writer-review-fix",
      "run-ci",
      "npm test",
      "npm run typecheck",
      "payment retr",
      "timeout counter-reset",
      "fixture-current-worker",
    ];
    for (const token of fixtureSpecificTokens) {
      assert.ok(
        !SUBAGENT_COMMAND_TOOL_DESCRIPTION.includes(token),
        `description must not coach fixture token '${token}'`,
      );
    }
  });

  it("registers only action and input without prompt metadata", () => {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-command-description-"));
    const tool = readRegisteredTool(agentDir);
    assert.equal(tool.description, SUBAGENT_COMMAND_TOOL_DESCRIPTION);
    assert.equal(tool.promptSnippet, undefined);
    assert.equal(tool.promptGuidelines, undefined);
    assert.deepEqual(tool.properties, ["action", "input"]);
    assert.deepEqual(tool.required, ["action"]);
  });

  it("fails loudly when removed toolDescriptionMode remains configured", () => {
    const agentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-subagents-removed-description-mode-"),
    );
    const configDir = path.join(agentDir, "extensions", "subagent");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ toolDescriptionMode: "compact" }),
      "utf-8",
    );
    assert.throws(
      () => readRegisteredTool(agentDir),
      /toolDescriptionMode was removed by the command-catalog hard cutover/,
    );
  });
});
