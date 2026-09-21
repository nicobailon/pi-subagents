const modules = {
	"@earendil-works/pi-agent-core": `
		export class Agent {}
	`,
	"@earendil-works/pi-coding-agent": `
		export function createReadOnlyTools() { return []; }
		export function convertToLlm(messages) { return messages; }
	`,
	"@earendil-works/pi-ai": `
		export const stableHostSurface = true;
	`,
	"@earendil-works/pi-ai/compat": `
		export function streamSimple() { throw new Error("not invoked by the linking smoke test"); }
	`,
};

export function resolve(specifier, context, nextResolve) {
	const source = modules[specifier];
	if (source !== undefined) {
		return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
