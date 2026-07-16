interface AsyncOverrideParams {
	async?: boolean;
	clarify?: boolean;
	foregroundOnly?: boolean;
}

export function applyForceTopLevelAsyncOverride<T extends AsyncOverrideParams>(
	params: T,
	depth: number,
	forceTopLevelAsync: boolean,
): T {
	if (params.foregroundOnly || !(depth === 0 && forceTopLevelAsync)) return params;
	return { ...params, async: true, clarify: false };
}
