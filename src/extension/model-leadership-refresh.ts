import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "../shared/types.ts";
import { ensureLeadership, rebuildLeadership } from "../model-leadership/index.ts";
import { setLeadershipArtifact } from "../runs/shared/model-fallback.ts";
import { setDefaultTTL } from "../runs/shared/model-exclusions.ts";

function getPiModelsFromRegistry(ctx: Pick<ExtensionContext, "modelRegistry">) {
	const allModels = ctx.modelRegistry.getAll();
	const available = ctx.modelRegistry.getAvailable();
	return allModels.map((model) => ({
		id: model.id,
		fullId: `${model.provider}/${model.id}`,
		provider: model.provider,
		name: model.name,
		isFree: model.name.toLowerCase().includes("free") || (model.cost.input === 0 && model.cost.output === 0),
		cost: model.cost,
		contextWindow: model.contextWindow,
		available: available.some((entry) => entry.id === model.id && entry.provider === model.provider),
	}));
}

export async function refreshModelLeadership(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	config: ExtensionConfig,
	forceRefresh = false,
): Promise<void> {
	const ttl = config.modelLeadership?.preferences?.exclusionTTLMs;
	if (typeof ttl === "number" && ttl > 0) setDefaultTTL(ttl);
	try {
		const piModels = getPiModelsFromRegistry(ctx);
		const artifact = await ensureLeadership({
			config: config.modelLeadership,
			getPiModels: () => piModels,
			forceRefresh,
		});
		if (artifact) setLeadershipArtifact(artifact);
	} catch (error) {
		console.error("[model-leadership] Failed to refresh leadership on session start:", error);
	}
}

export async function rebuildModelLeadership(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	config: ExtensionConfig,
): Promise<void> {
	try {
		const piModels = getPiModelsFromRegistry(ctx);
		const artifact = await rebuildLeadership({
			config: config.modelLeadership,
			getPiModels: () => piModels,
		});
		if (artifact) setLeadershipArtifact(artifact);
	} catch (error) {
		console.error("[model-leadership] Failed to rebuild leadership from existing snapshot:", error);
	}
}
