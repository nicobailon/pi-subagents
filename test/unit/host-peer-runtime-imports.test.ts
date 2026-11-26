import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createJiti } from "jiti";
import * as typeboxCompile from "typebox/compile";
import { HOST_PEER_ALIASES, resolveHostPeerAliases } from "../../src/runs/background/runner-aliases.ts";
import { resolveInstalledPiPackageRoot } from "../../src/runs/shared/pi-spawn.ts";

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

/** Walk the static runtime import graph from an entry point and list host peer imports outside `aliased`. */
function unaliasedHostPeerImports(entryPoint: string, aliased: ReadonlySet<string>): { violations: string[]; visited: number } {
	const visited = new Set<string>([entryPoint]);
	const queue: string[] = [entryPoint];
	const violations: string[] = [];
	while (queue.length > 0) {
		const file = queue.shift()!;
		const source = fs.readFileSync(file, "utf-8");
		for (const specifier of extractStaticImportSpecifiers(source)) {
			const hostPeerMatch = matchingHostPeerPackage(specifier);
			if (hostPeerMatch) {
				if (!aliased.has(specifier)) violations.push(`${path.relative(projectRoot, file)} imports '${specifier}' (host peer package '${hostPeerMatch}'), which has no alias`);
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
	return { violations, visited: visited.size };
}

test("every host peer package the detached async runner imports is aliased to the installed pi package (issues #334, #526)", () => {
	const aliased = new Set(HOST_PEER_ALIASES.map((entry) => entry.specifier));
	const { violations, visited } = unaliasedHostPeerImports(path.join(projectRoot, "src", "runs", "background", "subagent-runner.ts"), aliased);
	assert.equal(violations.length, 0, `runtime import graph reaches host peer package(s) the runner does not alias:\n${violations.join("\n")}`);
	assert.ok(visited > 20, `expected a non-trivial reachable file set (a broken resolver could undercount it), got ${visited}`);
	const packageRoot = resolveInstalledPiPackageRoot();
	assert.ok(packageRoot, "expected the pi package (or its test shim) to be resolvable");
	const resolved = resolveHostPeerAliases(packageRoot);
	assert.deepEqual(resolved.missing, []);
	// Optional subpaths the installed host does not export (pi-agent-core "./node" on Pi 1.2.0) resolve to no alias.
	for (const specifier of aliased) if (specifier in resolved.aliases) assert.ok(fs.existsSync(resolved.aliases[specifier]!), `alias target for ${specifier} exists`);
});

test("the standalone inspector runner reaches no host peer package, because its jiti has no alias map", () => {
	// inspector-runner.mjs runs `createJiti(import.meta.url)` from the installed package, where host peers are absent.
	const { violations, visited } = unaliasedHostPeerImports(path.join(projectRoot, "src", "inspectors", "inspector-runner.ts"), new Set());
	assert.equal(violations.length, 0, `inspector import graph reaches host peer package(s):\n${violations.join("\n")}`);
	assert.ok(visited > 20, `expected a non-trivial reachable file set (a broken resolver could undercount it), got ${visited}`);
});

test("resolves pi-agent-core/node to its exact package export instead of appending to the root alias", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-core-node-alias-"));
	const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-agent-core");
	const distDir = path.join(packageDir, "dist");
	try {
		fs.mkdirSync(distDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-agent-core",
			version: "0.85.1-test",
			exports: {
				".": "./dist/index.js",
				"./node": "./dist/node.js",
			},
		}), "utf-8");
		fs.writeFileSync(path.join(distDir, "index.js"), "export {};\n", "utf-8");
		fs.writeFileSync(path.join(distDir, "node.js"), "export {};\n", "utf-8");

		const resolved = resolveHostPeerAliases(root);
		assert.equal(resolved.aliases["@earendil-works/pi-agent-core"], fs.realpathSync(path.join(distDir, "index.js")));
		assert.equal(resolved.aliases["@earendil-works/pi-agent-core/node"], fs.realpathSync(path.join(distDir, "node.js")));
		assert.notEqual(resolved.aliases["@earendil-works/pi-agent-core/node"], path.join(distDir, "index.js", "node"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("structured output validation loads TypeBox through Pi's compiled-binary loader when the installed package has none (#3348)", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-binary-loader-"));
	try {
		const packageDir = path.join(root, "node_modules", "pi-subagents");
		fs.mkdirSync(packageDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "pi-subagents", type: "module" }));
		const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf-8")) as { dependencies: Record<string, string> };
		for (const dependency of Object.keys(packageJson.dependencies)) {
			const target = path.join(root, "node_modules", dependency);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.symlinkSync(fs.realpathSync(path.join(projectRoot, "node_modules", dependency)), target, "junction");
		}
		const bundled = path.join(packageDir, "structured-output.js");
		await build({ entryPoints: [path.join(projectRoot, "src", "runs", "shared", "structured-output.ts")], outfile: bundled, bundle: true, format: "esm", platform: "node", packages: "external", logLevel: "silent" });
		const jiti = createJiti(import.meta.url, { tryNative: false, moduleCache: false, virtualModules: { "typebox/compile": typeboxCompile } });
		const { validateStructuredOutputValue: validate } = await jiti.import<typeof import("../../src/runs/shared/structured-output.ts")>(bundled);
		const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
		assert.deepEqual(await validate(schema, { ok: true }), { status: "valid" });
		assert.equal((await validate(schema, { ok: "no" })).status, "invalid");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("chord is required only when the host declares it, and aliased host-first whenever present (#2026, #2854)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-chord-alias-"));
	const host = path.join(root, "host");
	const extension = path.join(root, "extension");
	const chord = "@earendil-works/chord";
	function writePackage(dir: string, name: string, version: string, exports: Record<string, string>, extra: Record<string, unknown> = {}) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, exports, ...extra }));
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
		const preChord = resolveHostPeerAliases(host);
		assert.deepEqual(preChord.missing, []);
		assert.equal(preChord.aliases[chord], undefined);
		assert.equal(preChord.aliases[`${chord}/context`], undefined);
		// An extension-local copy must never satisfy a missing host chord export.
		writePackage(path.join(extension, "node_modules", chord), chord, "0.85.1", { ".": "./index.mjs", "./context": "./context.mjs" });
		// Pi 1.2.0+ no longer depends on chord: an undeclared, absent chord is not required.
		for (const version of ["1.2.0", "2.0.0-test"]) {
			writePackage(host, "@earendil-works/pi-coding-agent", version, hostExports, { dependencies: { "@earendil-works/pi-tui": "^1.2.0" } });
			const result = resolveHostPeerAliases(host);
			assert.deepEqual(result.missing, [], version);
			assert.equal(result.aliases[chord], undefined, version);
		}
		// A host that declares chord (0.85 through 1.1) fails closed when it is missing.
		for (const field of ["dependencies", "optionalDependencies"]) {
			writePackage(host, "@earendil-works/pi-coding-agent", "1.1.0", hostExports, { [field]: { [chord]: "^1.1.0" } });
			const result = resolveHostPeerAliases(host);
			for (const specifier of [chord, `${chord}/context`]) assert.ok(result.missing.includes(specifier), field);
		}
		writePackage(host, "@earendil-works/pi-coding-agent", "0.85.1", hostExports, { dependencies: { [chord]: "^0.85.1" } });
		writePackage(hostChord, chord, "0.85.1", { ".": "./index.mjs", "./context": "./context.mjs" });
		let result = resolveHostPeerAliases(host);
		assert.deepEqual(result.missing, []);
		assert.equal(result.aliases[chord], fs.realpathSync(path.join(hostChord, "index.mjs")));
		assert.equal(result.aliases[`${chord}/context`], fs.realpathSync(path.join(hostChord, "context.mjs")));
		fs.unlinkSync(path.join(hostChord, "context.mjs"));
		assert.deepEqual(resolveHostPeerAliases(host).missing, [`${chord}/context`]);
		writePackage(host, "@earendil-works/pi-coding-agent", "0.84.3", hostExports);
		fs.rmSync(path.join(host, "node_modules", "@earendil-works/pi-tui"), { recursive: true });
		result = resolveHostPeerAliases(host);
		assert.deepEqual(result.missing, ["@earendil-works/pi-tui"], "pre-chord hosts still require TUI");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("requires pi-schema only when the host's pi-ai declares it, and never aliases it", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-pi-schema-"));
	const host = path.join(root, "host");
	const schema = "@earendil-works/pi-schema";
	const piAiDir = path.join(host, "node_modules", "@earendil-works", "pi-ai");
	function writePackage(dir: string, name: string, version: string, exports: Record<string, string>, extra: Record<string, unknown> = {}) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version, exports, ...extra }));
		for (const target of Object.values(exports)) {
			fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
			fs.writeFileSync(path.join(dir, target), "export {};\n");
		}
	}
	const writeSchema = (dir: string) => writePackage(dir, schema, "1.5.0", { ".": "./dist/index.js", "./formats": "./dist/formats/index.js" });
	function assertPresent() {
		const result = resolveHostPeerAliases(host);
		assert.deepEqual(result.missing.filter((specifier) => specifier.startsWith(schema)), []);
		assert.equal(result.aliases[schema], undefined);
	}
	try {
		writePackage(host, "@earendil-works/pi-coding-agent", "1.5.0", { ".": "./index.mjs" });
		writePackage(piAiDir, "@earendil-works/pi-ai", "1.5.0", { ".": "./index.mjs", "./compat": "./compat.mjs" }, { dependencies: { [schema]: "1.5.0" } });
		assert.deepEqual(resolveHostPeerAliases(host).missing.filter((specifier) => specifier.startsWith(schema)), [schema, `${schema}/formats`]);

		const hoisted = path.join(host, "node_modules", schema);
		writeSchema(hoisted);
		assertPresent();
		fs.rmSync(hoisted, { recursive: true });

		const nested = path.join(piAiDir, "node_modules", schema);
		writeSchema(nested);
		assertPresent();
		fs.rmSync(nested, { recursive: true });

		// pnpm: the host's pi-ai is a link, and pi-schema sits beside pi-ai's real path, not under the host.
		const store = path.join(root, ".pnpm", "pi-ai@1.5.0", "node_modules", "@earendil-works");
		fs.mkdirSync(store, { recursive: true });
		fs.renameSync(piAiDir, path.join(store, "pi-ai"));
		fs.symlinkSync(path.join(store, "pi-ai"), piAiDir, "junction");
		writeSchema(path.join(store, "pi-schema"));
		assertPresent();
		fs.rmSync(piAiDir);

		// Pre-1.5 pi-ai never imports it, so its absence is not a launch failure.
		writePackage(piAiDir, "@earendil-works/pi-ai", "1.2.0", { ".": "./index.mjs", "./compat": "./compat.mjs" });
		assertPresent();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("skips the pi-agent-core/node alias when the host package declares no ./node export", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agent-core-no-node-"));
	const packageDir = path.join(root, "node_modules", "@earendil-works", "pi-agent-core");
	const distDir = path.join(packageDir, "dist");
	try {
		fs.mkdirSync(distDir, { recursive: true });
		fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-agent-core",
			version: "1.0.0",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./package.json": "./package.json" },
		}), "utf-8");
		fs.writeFileSync(path.join(distDir, "index.js"), "export {};\n", "utf-8");

		const resolved = resolveHostPeerAliases(root);
		assert.equal(resolved.aliases["@earendil-works/pi-agent-core"], fs.realpathSync(path.join(distDir, "index.js")));
		assert.equal(resolved.aliases["@earendil-works/pi-agent-core/node"], undefined);
		assert.ok(!resolved.missing.includes("@earendil-works/pi-agent-core/node"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
