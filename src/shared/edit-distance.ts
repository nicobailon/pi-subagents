export function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		let diagonal = previous[0]!;
		previous[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			const above = previous[rightIndex]!;
			previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
				? diagonal
				: Math.min(diagonal, above, previous[rightIndex - 1]!) + 1;
			diagonal = above;
		}
	}
	return previous[right.length]!;
}

export function hasSingleAdjacentTransposition(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	const mismatch = [...left].findIndex((character, index) => character !== right[index]);
	return mismatch >= 0
		&& left[mismatch] === right[mismatch + 1]
		&& left[mismatch + 1] === right[mismatch]
		&& left.slice(mismatch + 2) === right.slice(mismatch + 2);
}

/** The closest candidate that is a likely typo of `requested`, compared case-insensitively. */
export function closestMatch(requested: string, candidates: Iterable<string>): string | undefined {
	const lower = requested.toLowerCase();
	return [...candidates]
		.map((candidate) => ({ candidate, distance: editDistance(lower, candidate.toLowerCase()) }))
		.filter(({ candidate, distance }) => distance <= Math.max(1, Math.floor(candidate.length / 4)) || hasSingleAdjacentTransposition(lower, candidate.toLowerCase()))
		.sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))[0]?.candidate;
}
