/**
 * Escape regex special characters for use in a RegExp constructor.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse YAML frontmatter from agent/chain files.
 * Handles both flat (key: value) and nested block (key: \n  sub: val) values.
 * Block values are stored as single strings with embedded newlines.
 * The indentation of the block content is preserved relative to the key.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");

	if (!normalized.startsWith("---")) {
		return { frontmatter, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { frontmatter, body: normalized };
	}

	const frontmatterBlock = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();

	const lines = frontmatterBlock.split("\n");
	let currentKey: string | null = null;
	let currentBlockLines: string[] | null = null;
	let currentIndent: number | null = null;

	for (const line of lines) {
		const indent = line.search(/\S|$/); // position of first non-whitespace char
		const trimmed = line.trim();

		if (currentKey !== null && currentBlockLines !== null && indent > (currentIndent ?? 0)) {
			// This line is part of the current block value
			currentBlockLines.push(line);
			continue;
		}

		// Flush any pending block value
		if (currentKey !== null && currentBlockLines !== null) {
			// Strip the common leading whitespace from the block so the
			// serializer can add its own indentation level.
			const rawBlock = currentBlockLines.join("\n");
			const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
			const prefix = leadingSpaces?.[1] ?? "";
			const stripped = prefix
				? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
				: rawBlock;
			frontmatter[currentKey] = stripped;
			currentKey = null;
			currentBlockLines = null;
			currentIndent = null;
		}

		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}

			if (value === "") {
				// Key with empty value — might start a block; defer storing until we see indent
				currentKey = match[1];
				currentBlockLines = [];
				currentIndent = indent;
			} else {
				// Simple key: value
				frontmatter[match[1]] = value;
			}
		}
		// Lines that don't match a key pattern (e.g., comments, empty lines) are ignored
	}

	// Flush final block value
	if (currentKey !== null && currentBlockLines !== null) {
		const rawBlock = currentBlockLines.join("\n");
		const leadingSpaces = rawBlock.match(/^([ \t]+)/m);
		const prefix = leadingSpaces?.[1] ?? "";
		const stripped = prefix
			? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
			: rawBlock;
		frontmatter[currentKey] = stripped;
	}

	return { frontmatter, body };
}
