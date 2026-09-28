import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };
import { writeAtomicJson } from "../shared/atomic-json.ts";
import { getAgentDir } from "../shared/utils.ts";

// major.minor.patch as one comparable number; undefined for anything else.
const versionNumber = (version: unknown) => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)
	? version.split(".").reduce((total, part) => total * 1e6 + Number(part), 0)
	: undefined;

export async function showUpgradeNotice(
	ctx: { hasUI: boolean; ui: { notify(message: string, type: "info"): void } },
	stateDir = path.join(getAgentDir(), "pi-subagents"),
	changelogPath = fileURLToPath(new URL("../../CHANGELOG.md", import.meta.url)),
	version = packageJson.version,
): Promise<void> {
	if (!ctx.hasUI) return;
	const statePath = path.join(stateDir, "last-seen-version.json");
	const lastSeen = await fs.promises.readFile(statePath, "utf-8").then((raw) => JSON.parse(raw).version).catch(() => undefined);
	const previous = versionNumber(lastSeen);
	const current = versionNumber(version);
	if (current === undefined || previous === current) return;
	writeAtomicJson(statePath, { version });
	if (previous === undefined || previous > current) return;

	const bullets = (await fs.promises.readFile(changelogPath, "utf-8")).split(/^## /m).flatMap((section) => {
		const released = versionNumber(/^\[([^\]]+)\]/.exec(section)?.[1]);
		if (released === undefined || released <= previous || released > current) return [];
		const highlights = section.split(/^### /m).find((part) => part.startsWith("Highlights")) ?? "";
		return (highlights.match(/^- .*/gm) ?? []).map((bullet) => bullet.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim());
	});
	ctx.ui.notify([
		`pi-subagents updated from ${lastSeen} to ${version}`,
		...bullets.slice(0, 5),
		...(bullets.length > 5 ? [`...and ${bullets.length - 5} more`] : []),
		"Changelog: https://github.com/nicobailon/pi-subagents/blob/main/CHANGELOG.md",
	].join("\n"), "info");
}
