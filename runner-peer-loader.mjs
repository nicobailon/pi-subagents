import { pathToFileURL } from "node:url";

let aliases = {};
let nativeRunner = false;
let compiledRunner = false;
let packageRootUrl;
const redirected = new Set([
	"@earendil-works/pi-tui",
]);

export function initialize(data) {
	aliases = data?.aliases ?? {};
	nativeRunner = data?.nativeRunner === true;
	compiledRunner = data?.compiledRunner === true;
	packageRootUrl = data?.packageRootUrl;
}

export function resolve(specifier, context, nextResolve) {
	const packageImport = typeof packageRootUrl === "string" && context.parentURL?.startsWith(packageRootUrl) === true;
	if (nativeRunner && (!compiledRunner || packageImport) ? aliases[specifier] : redirected.has(specifier) && aliases[specifier]) {
		return nextResolve(pathToFileURL(aliases[specifier]).href, context);
	}
	return nextResolve(specifier, context);
}
