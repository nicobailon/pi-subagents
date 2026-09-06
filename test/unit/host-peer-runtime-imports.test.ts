import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HOST_PEER_ALIASES, resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";
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

test("every host peer package the detached async runner imports is aliased to the installed pi package (issues #334, #526)", () => {
	const entryPoint = path.join(projectRoot, "src", "runs", "background", "subagent-runner.ts");
	const visited = new Set<string>([entryPoint]);
	const queue: string[] = [entryPoint];
	const violations: string[] = [];
	const aliased = new Set(HOST_PEER_ALIASES.map((entry) => entry.specifier));

	while (queue.length > 0) {
		const file = queue.shift()!;
		const source = fs.readFileSync(file, "utf-8");
		for (const specifier of extractStaticImportSpecifiers(source)) {
			const hostPeerMatch = matchingHostPeerPackage(specifier);
			if (hostPeerMatch) {
				if (!aliased.has(specifier)) violations.push(`${path.relative(projectRoot, file)} imports '${specifier}' (host peer package '${hostPeerMatch}'), which has no runner alias`);
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

	assert.equal(violations.length, 0, `runtime import graph reaches host peer package(s) the runner does not alias:\n${violations.join("\n")}`);
	assert.ok(visited.size > 20, `expected a non-trivial reachable file set (a broken resolver could undercount it), got ${visited.size}`);
	const packageRoot = resolveInstalledPiPackageRoot();
	assert.ok(packageRoot, "expected the pi package (or its test shim) to be resolvable");
	const resolved = resolveHostPeerAliases(packageRoot);
	assert.deepEqual(resolved.missing, []);
	for (const specifier of aliased) assert.ok(fs.existsSync(resolved.aliases[specifier]!), `alias target for ${specifier} exists`);
});

test("resolves pi-agent-core/node to its exact package export instead of appending to the root alias", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-core-node-alias-"));
	const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-agent-core");
	const distDir = path.join(packageDir, "dist");
	try {
		fs.mkdirSync(distDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-agent-core",
			version: "0.85.0-test",
			exports: {
				".": "./dist/index.js",
				"./node": "./dist/node.js",
			},
		}), "utf-8");
		fs.writeFileSync(path.join(distDir, "index.js"), "export {};\n", "utf-8");
		fs.writeFileSync(path.join(distDir, "node.js"), "export {};\n", "utf-8");

		const resolved = resolveHostPeerAliases(root);
		assert.equal(resolved.aliases["@earendil-works/pi-agent-core"], path.join(distDir, "index.js"));
		assert.equal(resolved.aliases["@earendil-works/pi-agent-core/node"], path.join(distDir, "node.js"));
		assert.notEqual(resolved.aliases["@earendil-works/pi-agent-core/node"], path.join(distDir, "index.js", "node"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function writeFakeTypeboxPackage(typeboxDir: string): void {
	fs.mkdirSync(typeboxDir, { recursive: true });
	fs.writeFileSync(
		path.join(typeboxDir, "package.json"),
		JSON.stringify({ name: "typebox", version: "0.0.0-test", exports: { "./compile": "./compile.mjs" } }),
	);
	fs.writeFileSync(path.join(typeboxDir, "compile.mjs"), "export function Compile() {\n\treturn { Check: () => true, Errors: () => [], fakeTypebox: true };\n}\n");
}

test("resolveCompileFromPackageRoot loads typebox/compile from a fake Pi host package root", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-host-root-"));
	try {
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fake-pi-coding-agent", version: "0.0.0" }));
		writeFakeTypeboxPackage(path.join(root, "node_modules", "typebox"));

		const compile = await resolveCompileFromPackageRoot(root);
		assert.equal(typeof compile, "function");
		const compiled = compile!({});
		assert.equal(compiled.Check({}), true);
		assert.deepEqual([...compiled.Errors({})], []);
		assert.equal((compiled as { fakeTypebox?: boolean }).fakeTypebox, true);
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

test("resolveCompileFromPackageRoot resolves typebox hoisted to an ancestor node_modules", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-hoisted-root-"));
	try {
		writeFakeTypeboxPackage(path.join(tmp, "node_modules", "typebox"));
		const packageRoot = path.join(tmp, "apps", "pi", "node_modules", "@earendil-works", "pi-coding-agent");
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.0.0" }));

		const compile = await resolveCompileFromPackageRoot(packageRoot);
		assert.equal(typeof compile, "function");
		const compiled = compile!({});
		assert.equal(compiled.Check({}), true);
		assert.equal((compiled as { fakeTypebox?: boolean }).fakeTypebox, true);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
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

test("chord is omitted before 0.85, but required host-first on chord-era and unknown hosts (#2026)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chord-alias-"));
	const host = path.join(root, "host");
	const extension = path.join(root, "extension");
	const chord = "@earendil-works/chord";
	function writePackage(dir: string, name: string, version: string, exports: Record<string, string>) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, exports }));
		for (const target of Object.values(exports)) fs.writeFileSync(path.join(dir, target), "export {};\n");
	}
	const hostChord = path.join(host, "node_modules", chord);
	try {
		const packages = new Map<string, Record<string, string>>();
		for (const { pkg, subpath } of HOST_PEER_ALIASES) {
			const exports = packages.get(pkg) ?? {};
			exports[subpath] = `./${subpath.replaceAll("/", "-")}.mjs`;
			packages.set(pkg, exports);
		}
		for (const [pkg, exports] of packages) {
			writePackage(pkg === "@earendil-works/pi-coding-agent" ? host : path.join(host, "node_modules", pkg), pkg, "0.84.3", exports);
		}
		const hostExports = packages.get("@earendil-works/pi-coding-agent")!;
		const preChord = resolveHostPeerAliases(host, extension);
		assert.deepEqual(preChord.missing, []);
		assert.equal(preChord.aliases[chord], undefined);
		assert.equal(preChord.aliases[`${chord}/context`], undefined);
		// An extension-local copy must never satisfy a missing host chord export.
		writePackage(path.join(extension, "node_modules", chord), chord, "0.85.1", { ".": "./index.mjs", "./context": "./context.mjs" });
		for (const version of ["0.85.0", "0.85.1", "1.0.0", "0.84.4-test", "unknown"]) {
			writePackage(host, "@earendil-works/pi-coding-agent", version, hostExports);
			const result = resolveHostPeerAliases(host, extension);
			for (const specifier of [chord, `${chord}/context`]) assert.ok(result.missing.includes(specifier), version);
		}
		writePackage(host, "@earendil-works/pi-coding-agent", "0.85.1", hostExports);
		writePackage(hostChord, chord, "0.85.1", { ".": "./index.mjs", "./context": "./context.mjs" });
		let result = resolveHostPeerAliases(host, extension);
		assert.deepEqual(result.missing, []);
		assert.equal(result.aliases[chord], path.join(hostChord, "index.mjs"));
		assert.equal(result.aliases[`${chord}/context`], path.join(hostChord, "context.mjs"));
		fs.unlinkSync(path.join(hostChord, "context.mjs"));
		assert.deepEqual(resolveHostPeerAliases(host, extension).missing, [`${chord}/context`]);
		writePackage(host, "@earendil-works/pi-coding-agent", "0.84.3", hostExports);
		fs.rmSync(path.join(host, "node_modules", "@earendil-works/pi-tui"), { recursive: true });
		result = resolveHostPeerAliases(host, extension);
		assert.deepEqual(result.missing, ["@earendil-works/pi-tui"], "pre-chord hosts still require TUI");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("server supplementation is host-first, missing-only, and restricted to matching 0.85.0", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-server-alias-"));
	const host = path.join(root, "host");
	const extension = path.join(root, "extension");
	const server = "@earendil-works/pi-server";
	function writePackage(dir: string, name: string, version: string, exports: Record<string, string> = {}) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, exports }));
		for (const target of Object.values(exports)) fs.writeFileSync(path.join(dir, target), "export {};\n");
	}
	const localServer = path.join(extension, "node_modules", server);
	const hostServer = path.join(host, "node_modules", server);
	const exports = { ".": "./public.mjs", "./unix": "./unix.mjs" };
	try {
		writePackage(host, "@earendil-works/pi-coding-agent", "0.85.0", { ".": "./sdk.mjs" });
		writePackage(localServer, server, "0.85.0", exports);
		writePackage(path.join(extension, "node_modules", "@earendil-works/pi-tui"), "@earendil-works/pi-tui", "0.85.0", exports);
		let result = resolveHostPeerAliases(host, extension);
		assert.deepEqual(result.supplemental, [server, `${server}/unix`]);
		assert.equal(result.aliases[server], path.join(localServer, "public.mjs"));
		assert.ok(result.missing.includes("@earendil-works/pi-tui"), "other missing peers stay closed");

		writePackage(hostServer, server, "0.85.0", { ".": "./host.mjs" });
		result = resolveHostPeerAliases(host, extension);
		assert.equal(result.aliases[server], path.join(hostServer, "host.mjs"));
		assert.deepEqual(result.supplemental, [`${server}/unix`]);
		writePackage(hostServer, server, "0.86.0", { ".": "./host.mjs" });
		assert.ok(resolveHostPeerAliases(host, extension).missing.includes(`${server}/unix`));
		fs.rmSync(hostServer, { recursive: true });

		for (const version of ["0.84.0", "0.85.1", "0.85.0-test"]) {
			writePackage(host, "@earendil-works/pi-coding-agent", version, { ".": "./sdk.mjs" });
			result = resolveHostPeerAliases(host, extension);
			assert.deepEqual(result.supplemental, []);
			for (const specifier of [server, `${server}/unix`, "@earendil-works/pi-client/unix"]) {
				assert.ok(!result.missing.includes(specifier));
				assert.equal(result.aliases[specifier], undefined);
			}
			assert.ok(result.missing.includes("@earendil-works/pi-agent-core/node"));
		}
		writePackage(host, "@earendil-works/pi-coding-agent", "0.85.0", { ".": "./sdk.mjs" });
		writePackage(localServer, server, "0.85.1", exports);
		assert.deepEqual(resolveHostPeerAliases(host, extension).supplemental, []);
		writePackage(localServer, server, "0.85.0", exports);
		fs.unlinkSync(path.join(localServer, "unix.mjs"));
		assert.ok(resolveHostPeerAliases(host, extension).missing.includes(`${server}/unix`));

		// Non-exception hosts ignore experimental packages even when installed.
		writePackage(host, "@earendil-works/pi-coding-agent", "0.86.0", { ".": "./sdk.mjs" });
		writePackage(hostServer, server, "0.86.0", exports);
		result = resolveHostPeerAliases(host, extension);
		assert.deepEqual(result.supplemental, []);
		assert.equal(result.aliases[`${server}/unix`], undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
