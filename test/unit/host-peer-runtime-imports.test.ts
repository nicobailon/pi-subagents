import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveCompileFromPackageRoot, validateStructuredOutputValue } from "../../src/runs/shared/structured-output.ts";
import type { JsonSchemaObject } from "../../src/shared/types.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const hostPeerPackages = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
] as const;

function matchingHostPeerPackage(specifier: string): string | undefined {
	return hostPeerPackages.find((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}

/** Extract specifiers from top-level static import/export-from statements, skipping type-only lines. */
function extractStaticImportSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	const lines = source.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!.trim();
		if (!/^(?:import|export)\b/.test(line)) {
			i++;
			continue;
		}
		// Multi-line statements (e.g. `import {\n\tFoo,\n} from "x";`) continue past this line: keep
		// pulling lines into one logical statement until we see the `from "..."` clause or a `;`.
		let statement = line;
		while (!/from\s+["'][^"']+["']/.test(statement) && !statement.includes(";") && i + 1 < lines.length) {
			i++;
			statement += ` ${lines[i]!.trim()}`;
		}
		i++;

		if (/^import\s+type\b/.test(statement) || /^export\s+type\b/.test(statement)) continue;
		const fromMatch = statement.match(/from\s+["']([^"']+)["']/);
		if (fromMatch) {
			specifiers.push(fromMatch[1]!);
			continue;
		}
		const sideEffectMatch = statement.match(/^import\s+["']([^"']+)["']/);
		if (sideEffectMatch) specifiers.push(sideEffectMatch[1]!);
	}
	return specifiers;
}

function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
	const base = path.dirname(fromFile);
	const candidates = [path.resolve(base, specifier), path.resolve(base, `${specifier}.ts`), path.resolve(base, specifier, "index.ts")];
	return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

test("detached async runner's runtime import graph never reaches a host peer package (issues #334, #526)", () => {
	const entryPoint = path.join(projectRoot, "src", "runs", "background", "subagent-runner.ts");
	const visited = new Set<string>([entryPoint]);
	const queue: string[] = [entryPoint];
	const violations: string[] = [];

	while (queue.length > 0) {
		const file = queue.shift()!;
		const source = fs.readFileSync(file, "utf-8");
		for (const specifier of extractStaticImportSpecifiers(source)) {
			const hostPeerMatch = matchingHostPeerPackage(specifier);
			if (hostPeerMatch) {
				violations.push(`${path.relative(projectRoot, file)} has a runtime import of '${specifier}' (host peer package '${hostPeerMatch}')`);
				continue;
			}
			if (!specifier.startsWith(".")) continue;
			const resolved = resolveRelativeImport(file, specifier);
			if (!resolved) {
				throw new Error(`Could not resolve relative import '${specifier}' from ${path.relative(projectRoot, file)}`);
			}
			if (!visited.has(resolved)) {
				visited.add(resolved);
				queue.push(resolved);
			}
		}
	}

	assert.equal(violations.length, 0, `runtime import graph reached host peer package(s):\n${violations.join("\n")}`);
	assert.ok(visited.size > 20, `expected a non-trivial reachable file set (a broken resolver could undercount it), got ${visited.size}`);
});

test("resolveCompileFromPackageRoot loads typebox/compile from a fake Pi host package root", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-host-root-"));
	try {
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fake-pi-coding-agent", version: "0.0.0" }));
		const typeboxDir = path.join(root, "node_modules", "typebox");
		fs.mkdirSync(typeboxDir, { recursive: true });
		fs.writeFileSync(
			path.join(typeboxDir, "package.json"),
			JSON.stringify({ name: "typebox", version: "0.0.0-test", exports: { "./compile": "./compile.mjs" } }),
		);
		fs.writeFileSync(path.join(typeboxDir, "compile.mjs"), "export function Compile() {\n\treturn { Check: () => true, Errors: () => [] };\n}\n");

		const compile = await resolveCompileFromPackageRoot(root);
		assert.equal(typeof compile, "function");
		const compiled = compile!({});
		assert.equal(compiled.Check({}), true);
		assert.deepEqual([...compiled.Errors({})], []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}

	const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-empty-root-"));
	try {
		await assert.rejects(resolveCompileFromPackageRoot(emptyRoot));
	} finally {
		fs.rmSync(emptyRoot, { recursive: true, force: true });
	}
});

test("validateStructuredOutputValue validates values against a JSON Schema", async () => {
	const valid = await validateStructuredOutputValue({ type: "object" }, {});
	assert.deepEqual(valid, { status: "valid" });

	const schema: JsonSchemaObject = {
		type: "object",
		properties: { a: { type: "number" } },
		required: ["a"],
		additionalProperties: false,
	};
	const invalid = await validateStructuredOutputValue(schema, {});
	assert.equal(invalid.status, "invalid");
	assert.ok(invalid.status === "invalid" && invalid.message.length > 0);
});
