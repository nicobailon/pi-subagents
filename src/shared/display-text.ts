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

const BINARY_CONTENT_PLACEHOLDER = "[binary content omitted for safe display]";

function isUnsafeTerminalCodePoint(codePoint: number): boolean {
	const terminalControl = (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a)
		|| (codePoint >= 0x7f && codePoint <= 0x9f);
	const bidiControl = codePoint === 0x061c
		|| codePoint === 0x200e
		|| codePoint === 0x200f
		|| (codePoint >= 0x202a && codePoint <= 0x202e)
		|| (codePoint >= 0x2066 && codePoint <= 0x2069);
	const privateUse = (codePoint >= 0xe000 && codePoint <= 0xf8ff)
		|| (codePoint >= 0xf0000 && codePoint <= 0xffffd)
		|| (codePoint >= 0x100000 && codePoint <= 0x10fffd);
	const invalidScalar = codePoint >= 0xd800 && codePoint <= 0xdfff;
	const nonCharacter = (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
		|| (codePoint & 0xffff) === 0xfffe
		|| (codePoint & 0xffff) === 0xffff;
	return terminalControl || bidiControl || privateUse || invalidScalar || nonCharacter;
}

function looksLikeBinaryContent(text: string): boolean {
	if (text.includes("\0")) return true;
	let suspiciousControls = 0;
	let replacementCharacters = 0;
	let codePoints = 0;
	for (const character of text) {
		codePoints++;
		const codePoint = character.codePointAt(0) ?? 0;
		if ((codePoint <= 0x08) || (codePoint >= 0x0e && codePoint <= 0x1f)) suspiciousControls++;
		if (codePoint === 0xfffd) replacementCharacters++;
	}
	if (codePoints === 0) return false;
	return (suspiciousControls >= 4 && suspiciousControls / codePoints >= 0.1)
		|| (replacementCharacters >= 3 && replacementCharacters / codePoints >= 0.1);
}

/** Escapes untrusted text before rendering it in a terminal while preserving safe newlines and tabs. */
export function safeTerminalText(value: string): string {
	const normalized = value.replace(/\r\n/g, "\n");
	if (looksLikeBinaryContent(normalized)) return BINARY_CONTENT_PLACEHOLDER;
	let safe = "";
	for (const character of normalized) {
		const codePoint = character.codePointAt(0) ?? 0;
		safe += isUnsafeTerminalCodePoint(codePoint)
			? `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`
			: character;
	}
	return safe;
}
