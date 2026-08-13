import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { agentStreamOptions } from "../../src/shared/agent-stream-options.ts";

describe("agent stream options", () => {
	it("supports the Pi 0.81 and 0.84 constructor option names", () => {
		const streamFn: StreamFn = () => { throw new Error("not called"); };
		const options = agentStreamOptions(streamFn);

		assert.equal(options.streamFunction, streamFn);
		assert.equal(options.streamFn, streamFn);
	});
});
