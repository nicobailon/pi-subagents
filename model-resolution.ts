import type { ModelInfo } from "./chain-clarify.js";

/**
 * Resolve a model name to provider/model format.
 *
 * Behavior:
 * - Full provider/model IDs are returned as-is.
 * - Bare model IDs prefer the parent session's current provider when available.
 * - If no preferred provider is available, fall back to the first registry match.
 */
export function resolveModelFullId(
	modelName: string | undefined,
	availableModels: ModelInfo[] = [],
	preferredProvider?: string,
): string | undefined {
	if (!modelName) return undefined;
	if (modelName.includes("/")) return modelName;

	const colonIdx = modelName.lastIndexOf(":");
	const baseModel = colonIdx !== -1 ? modelName.substring(0, colonIdx) : modelName;
	const thinkingSuffix = colonIdx !== -1 ? modelName.substring(colonIdx) : "";

	if (preferredProvider) {
		return `${preferredProvider}/${baseModel}${thinkingSuffix}`;
	}

	const match = availableModels.find((m) => m.id === baseModel);
	if (match) {
		return `${match.fullId}${thinkingSuffix}`;
	}

	return modelName;
}
