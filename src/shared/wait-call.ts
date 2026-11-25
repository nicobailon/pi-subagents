/** How text tells the model to wait for background work: the subagent tool's wait action. */
export function waitCall(fields = ""): string {
	return `subagent({ action: "wait"${fields ? `, ${fields}` : ""} })`;
}

/** How parent-facing text tells the model to wait for one run. */
export function waitForRunText(id: string): string {
	return `wait with ${waitCall(`id: "${id}"`)}`;
}
