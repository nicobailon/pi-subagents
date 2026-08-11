function codePointWidth(codePoint: number): 1 | 2 {
	return codePoint > 0xffff ? 2 : 1;
}

function isWhitespaceOrControl(codePoint: number): boolean {
	if (codePoint <= 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
	if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
	return String.fromCodePoint(codePoint).trim().length === 0;
}

function consumeControlString(value: string, index: number, osc: boolean): number {
	while (index < value.length) {
		const codePoint = value.codePointAt(index)!;
		const width = codePointWidth(codePoint);
		if (osc && codePoint === 0x07) return index + width;
		if (codePoint === 0x9c) return index + width;
		if (codePoint === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
		index += width;
	}
	return value.length;
}

function consumeCsi(value: string, index: number): number {
	while (index < value.length) {
		const codePoint = value.codePointAt(index)!;
		const width = codePointWidth(codePoint);
		if (codePoint >= 0x40 && codePoint <= 0x7e) return index + width;
		index += width;
	}
	return value.length;
}

export function sanitizeDisplayText(value: string): string {
	const output: string[] = [];
	let pendingSpace = false;

	const appendSpace = (): void => {
		if (output.length > 0) pendingSpace = true;
	};
	const appendText = (text: string): void => {
		if (pendingSpace) output.push(" ");
		output.push(text);
		pendingSpace = false;
	};

	for (let index = 0; index < value.length;) {
		const codePoint = value.codePointAt(index)!;
		const width = codePointWidth(codePoint);

		if (codePoint === 0x1b) {
			const next = value.charCodeAt(index + 1);
			appendSpace();
			if (next === 0x5b) {
				index = consumeCsi(value, index + 2);
				continue;
			}
			if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
				index = consumeControlString(value, index + 2, next === 0x5d);
				continue;
			}
			index += next ? 2 : 1;
			continue;
		}

		if (codePoint === 0x9b) {
			appendSpace();
			index = consumeCsi(value, index + width);
			continue;
		}
		if (codePoint === 0x90 || codePoint === 0x98 || codePoint === 0x9d || codePoint === 0x9e || codePoint === 0x9f) {
			appendSpace();
			index = consumeControlString(value, index + width, codePoint === 0x9d);
			continue;
		}

		if (isWhitespaceOrControl(codePoint)) appendSpace();
		else appendText(String.fromCodePoint(codePoint));
		index += width;
	}

	return output.join("");
}

export function truncateDisplayText(value: string, maxLength: number): string {
	if (maxLength <= 0) return "";
	if (value.length <= maxLength) return value;
	let output = "";
	for (const char of value) {
		if (output.length + char.length > maxLength) break;
		output += char;
	}
	return output;
}

export function previewDisplayText(value: string, maxLength: number): string {
	const normalized = sanitizeDisplayText(value);
	if (normalized.length <= maxLength) return normalized;
	if (maxLength <= 3) return truncateDisplayText(normalized, maxLength);
	return `${truncateDisplayText(normalized, maxLength - 3)}...`;
}
