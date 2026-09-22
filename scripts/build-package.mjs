import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-pkg");
const expectedRootModules = [
	"install.mjs",
	"runner-peer-preload.mjs",
	"runner-peer-loader.mjs",
	"inspector-runner.mjs",
	"async-retention-discovery-worker.mjs",
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

const rootModules = fs.readdirSync(root).filter((name) => name.endsWith(".mjs"));
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
publishedPackage.types = "./index.d.ts";
publishedPackage.exports = Object.fromEntries(Object.entries(sourcePackage.exports).map(([name, target]) => {
	if (typeof target !== "string" || !target.endsWith(".ts")) throw new Error(`Unsupported package export ${name}: ${String(target)}`);
	const base = target.slice(0, -3);
	for (const extension of [".js", ".d.ts"]) {
		if (!fs.existsSync(path.join(output, `${base.slice(2)}${extension}`))) throw new Error(`Missing compiled package export: ${base}${extension}`);
	}
	return [name, { types: `${base}.d.ts`, default: `${base}.js` }];
}));
publishedPackage.pi = {
	...sourcePackage.pi,
	extensions: ["./index.js"],
};
fs.writeFileSync(path.join(output, "package.json"), `${JSON.stringify(publishedPackage, null, 2)}\n`);
