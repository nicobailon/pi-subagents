import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const aliases = JSON.parse(process.env.JITI_ALIAS ?? "{}");
const nativeRunner = process.env.PI_ASYNC_NATIVE_RUNNER === "1";
const redirected = new Set([
	"@earendil-works/pi-server",
	"@earendil-works/pi-server/unix",
	"@earendil-works/pi-tui",
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((nativeRunner ? aliases[specifier] : redirected.has(specifier) && aliases[specifier])) {
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
