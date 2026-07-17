/**
 * Escape regex special characters for use in a RegExp constructor.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Fold a YAML folded block scalar while preserving more-indented lines and
 * every blank-line separator. Trailing whitespace is trimmed.
 */
function foldBlock(block: string): string {
	let folded = "";
	let hasContent = false;
	let previousIsMoreIndented = false;
	let blankLines = 0;

	for (const line of block.split("\n")) {
		const current = line.trimEnd();
		if (current.trim() === "") {
			if (hasContent) blankLines++;
			continue;
		}

		const currentIsMoreIndented = current.length > current.trimStart().length;
		if (hasContent) {
			if (blankLines > 0) {
				folded += "\n".repeat(blankLines + (previousIsMoreIndented || currentIsMoreIndented ? 1 : 0));
			} else {
				folded += previousIsMoreIndented || currentIsMoreIndented ? "\n" : " ";
			}
		}
		folded += current;
		hasContent = true;
		previousIsMoreIndented = currentIsMoreIndented;
		blankLines = 0;
	}

	return folded.trim();
}

/**
 * Normalize a simple-scalar frontmatter list from comma-separated or block-list syntax.
 * Only the standard `- item` marker is removed; ordinary hyphenated values stay intact.
 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/);
			return (listItem?.[1] ?? value).split(",");
		})
		.map((value) => value.trim())
		.filter(Boolean);
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
	let currentFolded = false;

	for (const line of lines) {
		const indent = line.search(/\S|$/); // position of first non-whitespace char
		const trimmed = line.trim();

		if (currentKey !== null && currentBlockLines !== null && (indent > (currentIndent ?? 0) || (currentFolded && trimmed === ""))) {
			// This line is part of the current block value
			currentBlockLines.push(line);
			continue;
		}

		// Flush any pending block value
		if (currentKey !== null && currentBlockLines !== null) {
			// Strip the common leading whitespace from the block so the
			// serializer can add its own indentation level.
			const rawBlock = currentBlockLines.join("\n");
			const leadingSpaces = rawBlock.match(/^[ \t]+(?=\S)/m);
			const prefix = leadingSpaces?.[0] ?? "";
			const stripped = prefix
				? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
				: rawBlock;
			frontmatter[currentKey] = currentFolded ? foldBlock(stripped) : stripped;
			currentKey = null;
			currentBlockLines = null;
			currentIndent = null;
			currentFolded = false;
		}

		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			const rawValue = match[2].trim();
			const isQuoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
			const value = isQuoted ? rawValue.slice(1, -1) : rawValue;
			const isFolded = !isQuoted && (rawValue === ">" || rawValue === ">-");

			if (value === "" || isFolded) {
				// Key with empty value or folded block indicator — defer storing until we see indent
				currentKey = match[1];
				currentBlockLines = [];
				currentIndent = indent;
				currentFolded = isFolded;
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
		const leadingSpaces = rawBlock.match(/^[ \t]+(?=\S)/m);
		const prefix = leadingSpaces?.[0] ?? "";
		const stripped = prefix
			? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
			: rawBlock;
		frontmatter[currentKey] = currentFolded ? foldBlock(stripped) : stripped;
	}

	return { frontmatter, body };
}
