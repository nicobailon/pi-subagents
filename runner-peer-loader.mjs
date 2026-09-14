import { pathToFileURL } from "node:url";

let aliases = {};
let nativeRunner = false;
const redirected = new Set([
	"@earendil-works/pi-tui",
]);

export function initialize(data) {
	aliases = data?.aliases ?? {};
	nativeRunner = data?.nativeRunner === true;
}

export function resolve(specifier, context, nextResolve) {
	if (nativeRunner ? aliases[specifier] : redirected.has(specifier) && aliases[specifier]) {
		return nextResolve(pathToFileURL(aliases[specifier]).href, context);
	}
	return nextResolve(specifier, context);
}
