// Opt-in native-host smoke: use one installed Pi package and its own peer modules.
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";

const root = process.env.PI_SUBAGENTS_NATIVE_PI_ROOT;
if (!root) throw new Error("PI_SUBAGENTS_NATIVE_PI_ROOT is required for the native-host smoke.");
const { aliases, missing } = resolveHostPeerAliases(root);
if (missing.length) throw new Error(`Native host lacks: ${missing.join(", ")}`);
process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = root;
registerHooks({ resolve(specifier, context, nextResolve) {
	return aliases[specifier]
		? { url: pathToFileURL(aliases[specifier]).href, shortCircuit: true }
		: nextResolve(specifier, context);
} });
