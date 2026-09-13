import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

const aliases = JSON.parse(process.env.JITI_ALIAS ?? "{}");
const nativeRunner = process.env.PI_ASYNC_NATIVE_RUNNER === "1";
const redirected = new Set([
	"@earendil-works/pi-server",
	"@earendil-works/pi-server/unix",
	"@earendil-works/pi-tui",
]);

// Older Node hosts use Jiti's resolver; synchronous hooks are unavailable there.
nodeModule.registerHooks?.({
	resolve(specifier, context, nextResolve) {
		const redirect = nativeRunner ? specifier.startsWith("@earendil-works/") : redirected.has(specifier);
		if (redirect && aliases[specifier]) {
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
