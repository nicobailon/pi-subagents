import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";
import { HERDR_PI_MODE_ENV } from "./src/runs/shared/herdr-pi-protocol.ts";
import { loadedPackageVersion, readInstalledPackageVersion } from "./src/shared/package-version.ts";

const registerExtension = process.env[HERDR_PI_MODE_ENV] === "1"
	? (await import("./src/extension/herdr-pi-bridge.ts")).default
	: process.env.PI_SUBAGENT_CHILD === "1"
	? undefined
	: (await import("./src/extension/index.ts")).default;

export default function registerSubagentExtension(pi: ExtensionAPI): void {
	const installedVersion = readInstalledPackageVersion();
	if (installedVersion !== loadedPackageVersion) {
		throw new Error(`pi-subagents ${installedVersion} is installed, but this Pi process still has ${loadedPackageVersion} loaded. Restart Pi to load the update; /reload cannot replace extension modules that Node has already loaded.`);
	}
	registerExtension?.(pi);
}
