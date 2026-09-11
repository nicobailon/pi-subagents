import assert from "node:assert/strict";
import os from "node:os";
import { describe, it } from "node:test";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";

describe("shared tool inheritance", () => {
	for (const host of ["parent", "runner"] as const) {
		it(`inherits ambient tools for ${host} children without role restrictions`, () => {
			const launch = buildInProcessChildLaunch({
				host, cwd: os.tmpdir(), childAgentName: "reviewer", childIndex: 0,
				sessionEnabled: false, inheritProjectContext: true,
				inheritGlobalContext: false, inheritSkills: false,
			});
			assert.equal(launch.session.tools, undefined);
			assert.equal(launch.session.ambientExtensions, true);
			assert.equal(launch.config.permissions, undefined);
			assert.equal(launch.launchResolvedExtensions.disableAmbientExtensions, false);
		});
		it(`preserves an explicit task extension override for ${host} children`, () => {
			const launch = buildInProcessChildLaunch({
				host, cwd: os.tmpdir(), childAgentName: "reviewer", childIndex: 0,
				sessionEnabled: false, inheritProjectContext: true,
				inheritGlobalContext: false, inheritSkills: false, extensions: [],
			});
			assert.equal(launch.session.ambientExtensions, false);
		});
	}
});
