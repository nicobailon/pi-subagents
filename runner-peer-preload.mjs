import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

const aliases = JSON.parse(process.env.JITI_ALIAS ?? "{}");
const nativeRunner = process.env.PI_ASYNC_NATIVE_RUNNER === "1";
const compiledRunner = process.env.PI_ASYNC_COMPILED_RUNNER === "1";
// Pi's jiti loader owns aliases for external extensions; these hooks only supply peers to our compiled package.
const packageRootUrl = new URL("./", import.meta.url).href;
const redirected = new Set([
	"@earendil-works/pi-tui",
]);

if (typeof nodeModule.registerHooks === "function") {
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			const packageImport = context.parentURL?.startsWith(packageRootUrl) === true;
			if ((nativeRunner && (!compiledRunner || packageImport) ? aliases[specifier] : redirected.has(specifier) && aliases[specifier])) {
				return nextResolve(pathToFileURL(aliases[specifier]).href, context);
			}
			try {
				return nextResolve(specifier, context);
			} catch (error) {
				if (nativeRunner && specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
				throw error;
			}
		},
	});
} else {
	nodeModule.register(new URL("./runner-peer-loader.mjs", import.meta.url), {
		data: { aliases, nativeRunner, compiledRunner, packageRootUrl },
	});
}
