/** Loader half of `slow-heavy-import-hook.mjs`; see that file for usage. */
import * as fs from "node:fs";

let options = {};

export function initialize(data) {
	options = data ?? {};
}

export async function resolve(specifier, context, nextResolve) {
	if (/subagent-runner\.(?:ts|js)$/.test(specifier)) {
		if (options.failImport) throw new Error(`simulated execution-graph import failure for ${specifier}`);
		return { url: options.stubUrl, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url === options.stubUrl) {
		await new Promise((resolve) => setTimeout(resolve, options.delayMs));
		fs.writeFileSync(options.markerPath, `${new Date().toISOString()}\n`);
	}
	return nextLoad(url, context);
}
