import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { showUpgradeNotice } from "../../src/extension/upgrade-notice.ts";

const CHANGELOG = "## [Unreleased]\n\n### Highlights\n\n- Unreleased.\n\n## [0.3.0]\n\n### Highlights\n\n- Newest [highlight](https://example.com).\n\n### Fixed\n\n- Not a highlight.\n\n## [0.2.0]\n\n### Highlights\n\n- Middle highlight.\n\n## [0.1.0]\n\n### Highlights\n\n- Already seen.\n";

it("announces each upgrade's highlights once, only in a UI session", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-upgrade-notice-"));
	const changelog = path.join(dir, "CHANGELOG.md");
	fs.writeFileSync(changelog, CHANGELOG);
	const notices: string[] = [];
	const start = (version: string, hasUI = true) => showUpgradeNotice({ hasUI, ui: { notify: (message: string) => notices.push(message) } }, dir, changelog, version);
	try {
		await start("0.1.0", false);
		assert.equal(fs.existsSync(path.join(dir, "last-seen-version.json")), false);
		await start("0.1.0");
		await start("0.1.0");
		assert.deepEqual(notices, []);
		await start("0.3.0");
		await start("0.3.0");
		assert.deepEqual(notices, ["pi-subagents updated from 0.1.0 to 0.3.0\n- Newest highlight.\n- Middle highlight.\nChangelog: https://github.com/nicobailon/pi-subagents/blob/main/CHANGELOG.md"]);
		fs.writeFileSync(path.join(dir, "last-seen-version.json"), "{");
		await start("0.3.0");
		assert.deepEqual([notices.length, JSON.parse(fs.readFileSync(path.join(dir, "last-seen-version.json"), "utf-8"))], [1, { version: "0.3.0" }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
