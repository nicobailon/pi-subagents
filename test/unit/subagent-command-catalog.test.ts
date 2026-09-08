import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseFanoutChildSubagentCatalogCall,
  parseSubagentCatalogCall,
  renderSubagentCatalogHelp,
  SUBAGENT_COMMAND_CATALOG_ACTIONS,
} from "../../src/extension/subagent-command-catalog.ts";
import { SUBAGENT_ACTIONS } from "../../src/shared/types.ts";

describe("subagent command catalog", () => {
  it("covers execute, help, and every canonical management action", () => {
    assert.deepEqual(SUBAGENT_COMMAND_CATALOG_ACTIONS, ["execute", "help", ...SUBAGENT_ACTIONS]);
  });

  it("maps valid execute and management envelopes into canonical requests", () => {
    assert.deepEqual(
      parseSubagentCatalogCall({
        action: "execute",
        input: { agent: "reviewer", task: "Review", context: "fresh", async: true },
      }),
      {
        ok: true,
        request: {
          kind: "execute",
          params: {
            agent: "reviewer",
            task: "Review",
            context: "fresh",
            async: true,
            output: true,
          },
        },
      },
    );
    assert.deepEqual(
      parseSubagentCatalogCall({
        action: "status",
        input: { id: "run-1", view: "transcript", lines: 25 },
      }),
      {
        ok: true,
        request: {
          kind: "management",
          params: { action: "status", id: "run-1", view: "transcript", lines: 25 },
        },
      },
    );
  });

  it("preserves named-resource input without creating authority fields", () => {
    const parsed = parseSubagentCatalogCall({
      action: "execute",
      input: { workflow: "run-ci", args: { command: "npm test" }, async: true },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok || parsed.request.kind !== "execute") {
      return;
    }
    assert.deepEqual(parsed.request.params, {
      workflow: "run-ci",
      args: { command: "npm test" },
      async: true,
    });
    for (const field of ["resource", "resourcePermit", "workflowResourcePermit"]) {
      assert.equal(Object.hasOwn(parsed.request.params, field), false);
    }
  });

  it("rejects unknown actions, root legacy fields, action injection, mixed modes, and private fields", () => {
    const malformedCalls = [
      { action: "unknown", input: {} },
      { action: "execute", agent: "worker" },
      { action: "execute", input: { action: "status", agent: "worker" } },
      { action: "execute", input: { agent: "worker", workflowScript: "return 1" } },
      { action: "status", input: { id: "run-1", workflowScript: "return 1" } },
      { action: "execute", input: { workflow: "review", resourcePermit: { forged: true } } },
      { action: "execute", input: { workflowScript: "return 1", runFanoutAdmitted: true } },
    ];
    for (const call of malformedCalls) {
      assert.equal(parseSubagentCatalogCall(call).ok, false, JSON.stringify(call));
    }
  });

  it("rejects inappropriate operation fields even when their canonical types are valid", () => {
    assert.deepEqual(
      parseSubagentCatalogCall({ action: "status", input: { model: "openai/gpt-5" } }),
      {
        ok: false,
        error: "Action 'status' does not accept input field(s): model.",
      },
    );
    assert.equal(
      parseSubagentCatalogCall({
        action: "lane.recordMerge",
        input: { laneId: "lane", handoffPath: "handoff.json" },
      }).ok,
      false,
    );
    assert.deepEqual(
      parseSubagentCatalogCall({
        action: "mission.attach-run",
        input: { missionId: "mission-1", dir: "/tmp/run-1" },
      }),
      {
        ok: false,
        error: "Action 'mission.attach-run' requires at least one input field from: id, runId.",
      },
    );
    assert.equal(
      parseSubagentCatalogCall({
        action: "mission.attach-run",
        input: { missionId: "mission-1", runId: "run-1", dir: "/tmp/run-1" },
      }).ok,
      true,
    );
  });

  it("keeps raw scripts untrusted and help stateless", () => {
    const raw = parseSubagentCatalogCall({
      action: "execute",
      input: { workflowScript: "return runs.host('ci', {kind:'command',command:'npm test'})" },
    });
    assert.equal(raw.ok, true);
    if (raw.ok && raw.request.kind === "execute") {
      assert.equal(Object.hasOwn(raw.request.params, "workflow"), false);
    }
    assert.deepEqual(parseSubagentCatalogCall({ action: "help", input: { topic: "control" } }), {
      ok: true,
      request: { kind: "help", topic: "control" },
    });
  });

  it("serves compact core help and detailed operation contracts", () => {
    const workflows = renderSubagentCatalogHelp("workflows").content[0];
    assert.equal(workflows?.type, "text");
    if (workflows?.type === "text") {
      assert.match(workflows.text, /branch on awaited contents.*structuredOutput verdict/);
      assert.match(workflows.text, /structuredOutput.*outputSchema.*before launch/);
      assert.match(workflows.text, /results\/output are terminal/);
      assert.match(workflows.text, /runs\.all.*ordered array/i);
      assert.match(workflows.text, /help grants nothing/i);
      assert.match(workflows.text, /runs\.host\(key,\{kind:'command',command/);
      assert.match(workflows.text, /caller-authored.*denied before dispatch/i);
      assert.match(workflows.text, /never delegate.*substitute host command/i);
      for (const fixtureToken of ["writer-review-fix", "run-ci", "npm test"]) {
        assert.ok(
          !workflows.text.includes(fixtureToken),
          `workflows help must not coach fixture token '${fixtureToken}'`,
        );
      }
    }
    const execute = renderSubagentCatalogHelp("execute").content[0];
    assert.equal(execute?.type, "text");
    if (execute?.type === "text") {
      assert.match(execute.text, /Choose exactly one launch form/);
    }
    const schedule = renderSubagentCatalogHelp("contract:schedule.create").content[0];
    assert.equal(schedule?.type, "text");
    if (schedule?.type === "text") {
      assert.match(schedule.text, /workflowScript/);
      assert.match(schedule.text, /baseRef/);
      assert.match(schedule.text, /Unknown fields.*rejected before execution/i);
    }
    const executeContract = renderSubagentCatalogHelp("contract:execute").content[0];
    assert.equal(executeContract?.type, "text");
    if (executeContract?.type === "text") {
      assert.match(executeContract.text, /extensionBindings \(optional\)/);
    }
  });

  it("gives fanout children an explicitly restricted parser", () => {
    assert.equal(
      parseFanoutChildSubagentCatalogCall({ action: "execute", input: { agent: "scout" } }).ok,
      true,
    );
    assert.equal(
      parseFanoutChildSubagentCatalogCall({ action: "status", input: { id: "run-1" } }).ok,
      true,
    );
    const denied = parseFanoutChildSubagentCatalogCall({
      action: "create",
      input: { config: { name: "x" } },
    });
    assert.deepEqual(denied, {
      ok: false,
      error: "Action 'create' is not available from child-safe subagent fanout mode.",
    });
  });
});
