import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  runSessionAttempt,
  shutdownEvalAgentSession,
  type EvalSessionLifecycleHandle,
} from "../eval/lib/runner-session.ts";

function lifecycleSession(
  emit: EvalSessionLifecycleHandle["extensionRunner"]["emit"],
  events: string[],
): EvalSessionLifecycleHandle {
  return {
    extensionRunner: {
      async emit(event) {
        events.push(`${event.type}:${event.reason}`);
        return emit(event);
      },
    },
    dispose() {
      events.push("dispose");
    },
  };
}

describe("paired evaluator session lifecycle", () => {
  it("emits extension shutdown before disposing the session", async () => {
    const events: string[] = [];
    const error = await shutdownEvalAgentSession(lifecycleSession(async () => undefined, events));

    assert.equal(error, undefined);
    assert.deepEqual(events, ["session_shutdown:quit", "dispose"]);
  });

  it("still disposes and reports an extension shutdown failure", async () => {
    const events: string[] = [];
    const error = await shutdownEvalAgentSession(
      lifecycleSession(async () => {
        throw new Error("cleanup broke");
      }, events),
    );

    assert.equal(error, "session shutdown failed: cleanup broke");
    assert.deepEqual(events, ["session_shutdown:quit", "dispose"]);
  });

  it("shuts down a created session when extension setup reports errors", async () => {
    const events: string[] = [];
    const session = {
      ...lifecycleSession(async () => undefined, events),
      async prompt() {
        throw new Error("prompt should not run after setup failure");
      },
      async abort() {},
      subscribe() {
        return () => {};
      },
      messages: [],
      agent: { state: { systemPrompt: "test prompt" } },
    };
    class ResourceLoader {
      async reload() {}
    }

    const attempt = await runSessionAttempt({
      fixture: { id: "setup-failure", prompt: "delegate" },
      discoveryAgents: [],
      variant: {
        kind: "baseline",
        root: "/baseline",
        description: "test tool",
        descriptionKind: "test",
        publishedDefinition: { name: "subagent", description: "test tool", parameters: {} },
        canonicalize: () => ({ ok: true, request: { kind: "help" } }),
        renderHelp: () => ({ content: [{ type: "text", text: "help" }] }),
        async runWorkflowScript() {
          throw new Error("workflow should not run after setup failure");
        },
        validateWorkflowScript: () => ({ ok: true }),
      },
      variantOrder: ["baseline", "candidate"],
      model: { provider: "test", id: "model" },
      modelLabel: "test/model",
      thinkingLevel: "high",
      repetition: 1,
      attemptIndex: 1,
      suite: "test",
      piSdk: {
        async createAgentSession() {
          return { session, extensionsResult: { errors: ["broken extension"] } };
        },
        DefaultResourceLoader: ResourceLoader,
        defineTool: (definition) => definition,
        getAgentDir: () => "/agent",
        SessionManager: { inMemory: () => ({}) },
        SettingsManager: { inMemory: () => ({}) },
        ModelRuntime: { create: async () => ({}) },
        resolveCliModel: () => ({}),
      },
      modelRuntime: {},
      providerExtensionPaths: ["/provider.js"],
      options: {
        maxTurns: 1,
        timeoutMs: 1_000,
        systemPrompt: "test prompt",
        recordMessages: false,
      },
      sessionDir: "/session",
    });

    assert.equal(attempt.outcome, "setup-error");
    assert.match(attempt.promptError ?? "", /broken extension/);
    assert.deepEqual(events, ["session_shutdown:quit", "dispose"]);
  });
});
