import { pathToFileURL } from "node:url";

let aliases = {};
const redirected = new Set([
	"@earendil-works/pi-server",
	"@earendil-works/pi-server/unix",
	"@earendil-works/pi-tui",
]);

export function initialize(data) {
	aliases = data?.aliases ?? {};
}

export function resolve(specifier, context, nextResolve) {
	if (redirected.has(specifier) && aliases[specifier]) {
		return nextResolve(pathToFileURL(aliases[specifier]).href, context);
	}
	return nextResolve(specifier, context);
}
