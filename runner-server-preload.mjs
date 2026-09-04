// Only loaded when the parent supplies Pi 0.85.0's missing server exports.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const aliases = JSON.parse(process.env.JITI_ALIAS);
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-server" || specifier === "@earendil-works/pi-server/unix") {
			return nextResolve(pathToFileURL(aliases[specifier]).href, context);
		}
		return nextResolve(specifier, context);
	},
});
