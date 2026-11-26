/** Only a line of backticks can close a report; backticks in JSON strings are evidence. */
export function* closedAcceptanceReportFences(text: string) {
	if (!text.includes("```")) return;
	const markers = /(?:^|\n)[ \t]*(`{3,})(acceptance[-_]report|json[5c]?)?[ \t]*(?=\r?\n|$)/gi;
	let open: { start: number; bodyStart: number; width: number; explicit: boolean } | undefined;
	for (const match of text.matchAll(markers)) {
		const width = match[1]!.length;
		const tag = match[2];
		const end = match.index + match[0].length;
		if (open) {
			if (!tag && width >= open.width) {
				yield { start: open.start, end, explicit: open.explicit, body: text.slice(open.bodyStart, match.index).trim() };
				open = undefined;
			}
		} else if (tag) {
			open = { start: match.index, bodyStart: end, width, explicit: /^acceptance/i.test(tag) };
		}
	}
}
