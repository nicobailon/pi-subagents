export function waitCall(fields = ""): string {
	return `subagent({ action: "wait"${fields ? `, ${fields}` : ""} })`;
}

export function waitForRunText(id: string): string {
	return `wait with ${waitCall(`id: "${id}"`)}`;
}
