import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const aliases = JSON.parse(process.env.JITI_ALIAS ?? "{}");

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (aliases[specifier]) {
			return nextResolve(pathToFileURL(aliases[specifier]).href, context);
		}
		try {
			return nextResolve(specifier, context);
		} catch (error) {
			if (specifier.endsWith(".js")) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
			throw error;
		}
	},
});
