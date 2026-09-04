export function validateModelResponseAliases(value: unknown, label = "config.modelResponseAliases"): void {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
	for (const [candidate, aliases] of Object.entries(value)) {
		const slash = candidate.indexOf("/");
		if (slash <= 0 || !candidate.slice(0, slash).trim() || !candidate.slice(slash + 1).trim()) {
			throw new Error(`${label} key ${JSON.stringify(candidate)} must be a non-empty provider/model ID`);
		}
		if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
			throw new Error(`${label}[${JSON.stringify(candidate)}] must be an array of non-empty response ID strings`);
		}
	}
}
