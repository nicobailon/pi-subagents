import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldUseNativeFsWatch, type FileWatchPurpose } from "../../src/shared/watch-strategy.ts";

const purposes: FileWatchPurpose[] = [
	"result-delivery",
	"supervisor-channel",
	"async-job-tracker",
	"runner-control-inbox",
	"child-steering-inbox",
];

describe("watch strategy", () => {
	it("disables native filesystem watchers on Darwin", () => {
		for (const purpose of purposes) assert.equal(shouldUseNativeFsWatch(purpose, "darwin"), false);
	});

	it("keeps native filesystem watchers on non-Darwin platforms", () => {
		for (const purpose of purposes) {
			assert.equal(shouldUseNativeFsWatch(purpose, "linux"), true);
			assert.equal(shouldUseNativeFsWatch(purpose, "win32"), true);
		}
	});
});
