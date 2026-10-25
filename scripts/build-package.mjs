import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-pkg");
const expectedRootModules = [
	"install.mjs",
	"runner-peer-preload.mjs",
	"runner-peer-loader.mjs",
	"inspector-runner.mjs",
	"async-retention-discovery-worker.mjs",
	"workflow-script-worker.cjs",
];
const staticFiles = [
	"README.md",
	"CHANGELOG.md",
	"LICENSE",
];
const expectedDirectories = ["agents", "skills", "prompts", "docs"];

for (const relativePath of [
	...expectedRootModules,
	...staticFiles,
	...expectedDirectories,
	"index.ts",
	"src",
	"package.json",
	"tsconfig.json",
	"tsconfig.build.json",
]) {
	if (!fs.existsSync(path.join(root, relativePath))) throw new Error(`Missing package input: ${relativePath}`);
}

fs.rmSync(output, { recursive: true, force: true });
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tsc)) throw new Error("Missing TypeScript compiler; run npm install first");
execFileSync(process.execPath, [tsc, "-p", path.join(root, "tsconfig.build.json")], { cwd: root, stdio: "inherit" });

const runnerBootstrap = fs.readFileSync(path.join(output, "src/runs/background/subagent-runner-bootstrap.js"), "utf8");
if (!runnerBootstrap.includes('import("./subagent-runner.js")')) {
	throw new Error("Compiled runner bootstrap must dynamically import the heavy execution module");
}
if (/^import\s+.*["']\.\/subagent-runner\.js["'];?$/m.test(runnerBootstrap)) {
	throw new Error("Compiled runner bootstrap must not statically import the heavy execution module");
}

const rootModules = fs.readdirSync(root).filter((name) => name.endsWith(".mjs") || name === "workflow-script-worker.cjs");
for (const relativePath of [...rootModules, ...staticFiles]) {
	fs.copyFileSync(path.join(root, relativePath), path.join(output, relativePath));
}
for (const relativePath of expectedDirectories) {
	fs.cpSync(path.join(root, relativePath), path.join(output, relativePath), { recursive: true });
}

const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (sourcePackage.private !== true) throw new Error("The source package must remain private; publish only ./dist-pkg");
const copyFields = [
	"name", "version", "description", "author", "license", "repository", "homepage", "bugs",
	"bin", "dependencies", "peerDependencies", "peerDependenciesMeta", "engines", "keywords",
];
const publishedPackage = { type: sourcePackage.type };
for (const field of copyFields) {
	if (sourcePackage[field] !== undefined) publishedPackage[field] = sourcePackage[field];
}
// The extension entry and every subpath export load from one bundled module graph (#2980).
// Loading ~240 separate modules costs seconds on Windows; shared chunks keep one copy of module state.
// The compiled files stay in the package for child processes, and each bundled module keeps the
// import.meta.url of its compiled file, so paths to agents, prompts, runners and package.json do not change.
const bundleEntries = Object.entries(sourcePackage.exports).map(([name, target]) => {
	if (typeof target !== "string" || !target.endsWith(".ts")) throw new Error(`Unsupported package export ${name}: ${String(target)}`);
	return { name, target, out: name === "." ? "index" : name.slice(2) };
});
const compiledModuleUrls = new Set();
await build({
	absWorkingDir: root,
	entryPoints: bundleEntries.map(({ target, out }) => ({ in: target, out })),
	outdir: path.join(output, "bundle"),
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	chunkNames: "chunk-[hash]",
	logLevel: "warning",
	plugins: [{
		name: "compiled-module-url",
		setup(bundler) {
			bundler.onLoad({ filter: /\.ts$/ }, async (args) => {
				const compiled = `${path.relative(root, args.path).split(path.sep).join("/").slice(0, -3)}.js`;
				const source = await fs.promises.readFile(args.path, "utf8");
				if (!source.includes("import.meta.url")) return { contents: source, loader: "ts" };
				compiledModuleUrls.add(compiled);
				const moduleUrl = `new URL(${JSON.stringify(`../${compiled}`)}, import.meta.url).href`;
				return { contents: source.replaceAll("import.meta.url", moduleUrl), loader: "ts" };
			});
		},
	}],
});
for (const compiled of compiledModuleUrls) {
	if (!fs.existsSync(path.join(output, compiled))) throw new Error(`Bundled module points at a missing compiled file: ${compiled}`);
}

publishedPackage.types = "./index.d.ts";
publishedPackage.exports = Object.fromEntries(bundleEntries.map(({ name, target, out }) => {
	const base = target.slice(0, -3);
	if (!fs.existsSync(path.join(output, `${base.slice(2)}.d.ts`))) throw new Error(`Missing compiled package export: ${base}.d.ts`);
	if (!fs.existsSync(path.join(output, "bundle", `${out}.js`))) throw new Error(`Missing bundled package export: ./bundle/${out}.js`);
	return [name, { types: `${base}.d.ts`, default: `./bundle/${out}.js` }];
}));
publishedPackage.pi = {
	...sourcePackage.pi,
	extensions: ["./bundle/index.js"],
};
fs.writeFileSync(path.join(output, "package.json"), `${JSON.stringify(publishedPackage, null, 2)}\n`);
