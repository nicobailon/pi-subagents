import { writeFileSync } from "node:fs";
import { bindInheritedLaunchCapabilities } from "../../src/runs/shared/launch-capabilities.ts";

const bound = await bindInheritedLaunchCapabilities({
	childSessionId: process.env.TEST_CHILD_SESSION_ID,
	cwd: process.cwd(),
});
const capabilityId = "devspec.claim-authority.v1";
const first = await bound.authorize(capabilityId);
const second = await bound.authorize(capabilityId);
const envelopeCleared = process.env.PI_SUBAGENT_LAUNCH_CAPABILITIES_V1 === undefined;
if (first.ok && second.ok && process.env.TEST_WRITE_PATH) writeFileSync(process.env.TEST_WRITE_PATH, "delegated writer mutation\n", "utf8");
await bound.release();
process.stdout.write(`${JSON.stringify({ first, second, envelopeCleared, projection: bound.projection(capabilityId) })}\n`);
