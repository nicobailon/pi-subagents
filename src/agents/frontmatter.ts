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
 * A trailing ` #...` comment is dropped from unquoted `- item` lines. Single-line values are left
 * alone because parseFrontmatter has already removed their quotes, so `"notes #1.md"` must survive.
 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/)?.[1];
			const item = listItem === undefined || /^["']/.test(listItem) ? listItem ?? value : listItem.replace(/(?:^|\s)#.*$/, "");
			return item.split(",");
		})
		.map((value) => value.trim())
		.filter(Boolean);
}

function unquoteName(value: string): string {
	if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
		return value.slice(1, -1);
	}
	return value;
}

/** A tool or extension name list whose items may each be quoted, as in `"read", "bash"` or `- "read"`. */
export function parseUnquotedList(raw: string | undefined): string[] | undefined {
	return parseFrontmatterList(raw)?.map(unquoteName);
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
	let currentLiteral = false;

	for (const line of lines) {
		const indent = line.search(/\S|$/);
		const trimmed = line.trim();

		// Comment lines are content only inside a | or > block scalar. Elsewhere they must
		// neither end a pending list block nor become part of its value.
		if (trimmed.startsWith("#") && !currentFolded && !currentLiteral) continue;

		// Exactly-empty lines belong to any pending block, not only to | and > scalars.
		if (currentKey !== null && currentBlockLines !== null && (indent > (currentIndent ?? 0) || trimmed === "")) {
			currentBlockLines.push(line);
			continue;
		}

		if (currentKey !== null && currentBlockLines !== null) {
			frontmatter[currentKey] = flushBlockLines(currentBlockLines, currentFolded, currentLiteral);
			currentKey = null;
			currentBlockLines = null;
			currentIndent = null;
			currentFolded = false;
			currentLiteral = false;
		}

		const match = line.match(/^([\w-]+):\s*(.*)$/);
		if (match) {
			const [key, rawValueValue] = match.slice(1);
			if (key === undefined || rawValueValue === undefined) continue;
			const rawValue = rawValueValue.trim();
			const quote = rawValue[0];
			const nameList = key === "tools" || key === "excludeTools" || key === "mutationTools" || key === "extensions" || key === "subagentOnlyExtensions";
			// `"read", "bash"` starts and ends with a quote, but it is a list. Keep those item quotes for the splitter.
			const quotedList = nameList && (quote === '"' || quote === "'") && (rawValue.includes(`${quote},`) || rawValue.includes(`, ${quote}`));
			const isQuoted = !quotedList && (quote === '"' || quote === "'") && rawValue.endsWith(quote);
			const value = isQuoted ? rawValue.slice(1, -1) : rawValue;
			const isFolded = !isQuoted && (rawValue === ">" || rawValue === ">-");
			const isLiteral = !isQuoted && (rawValue === "|" || rawValue === "|-");

			if (value === "" || isFolded || isLiteral) {
				// Key with empty value or block scalar indicator — defer storing until we see indent
				currentKey = key;
				currentBlockLines = [];
				currentIndent = indent;
				currentFolded = isFolded;
				currentLiteral = isLiteral;
			} else {
				frontmatter[key] = value;
			}
		}
	}

	if (currentKey !== null && currentBlockLines !== null) {
		frontmatter[currentKey] = flushBlockLines(currentBlockLines, currentFolded, currentLiteral);
	}

	return { frontmatter, body };
}

function flushBlockLines(blockLines: string[], folded: boolean, literal: boolean): string {
	let lines = blockLines;
	if (!folded && !literal) {
		// Drop exactly-empty edge lines, and every line from the first exactly-empty one after
		// the last content line, so nested values without inner blank lines parse as before.
		const end = lines.indexOf("", lines.findLastIndex((line) => line.trim() !== "") + 1);
		lines = lines.slice(lines.findIndex((line) => line !== ""), end < 0 ? lines.length : end);
	}
	// Strip the common leading whitespace from the block so the
	// serializer can add its own indentation level.
	const rawBlock = lines.join("\n");
	const leadingSpaces = rawBlock.match(/^[ \t]+(?=\S)/m);
	const prefix = leadingSpaces?.[0] ?? "";
	const stripped = prefix
		? rawBlock.replace(new RegExp(`^${escapeRegex(prefix)}`, "gm"), "").replace(/^\n/, "")
		: rawBlock;
	return folded ? foldBlock(stripped) : stripped;
}
