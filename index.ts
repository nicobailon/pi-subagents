import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";
import { HERDR_PI_MODE_ENV } from "./src/runs/shared/herdr-pi-protocol.ts";

const registerExtension = process.env[HERDR_PI_MODE_ENV] === "1"
	? (await import("./src/extension/herdr-pi-bridge.ts")).default
	: process.env.PI_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	registerExtension?.(pi);
}
