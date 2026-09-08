// Complete official binary gate. Each mode uses the existing fresh-stage driver.
// Usage: node test/smoke/standalone-matrix.mjs /absolute/official-pi /fresh/artifacts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../", import.meta.url));
const release = JSON.parse(fs.readFileSync(new URL("standalone-release.json", import.meta.url), "utf8"));
const binary = process.argv[2];
const root = process.argv[3];
assert.equal(process.platform, release.platform);
assert.equal(process.arch, release.arch);
assert.ok(binary && path.isAbsolute(binary) && fs.existsSync(binary), "official binary is required; never skip");
assert.ok(root && path.isAbsolute(root) && !fs.existsSync(root), "provide a fresh absolute artifact directory");
function sha(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
assert.equal(sha(binary), release.binarySha256, "binary does not match the pinned official release");
fs.mkdirSync(root, { recursive: true });
const inputs = ["index.ts", "package.json", "package-lock.json",
	...fs.readdirSync(source).filter((file) => file.endsWith(".mjs")),
	...fs.readdirSync(path.join(source, "src"), { recursive: true }).map((file) => `src/${file}`),
	...fs.readdirSync(path.join(source, "test/smoke")).filter((file) => file.startsWith("standalone-")).map((file) => `test/smoke/${file}`),
].filter((file) => fs.statSync(path.join(source, file)).isFile()).sort();
const frozen = Object.fromEntries(inputs.map((file) => [file, sha(path.join(source, file))]));
fs.writeFileSync(path.join(root, "inputs.json"), JSON.stringify(frozen, null, 2));
const modes = ["single", "workflow", "shared-run", "parallel-stop", "targeted-controls", "steer", "interrupt", "stop", "child-stop", "child-timeout", "run-timeout", "tool-timeout", "missing-bootstrap", "persistence-failure", "authorization-failure", "sdk-init-failure", "bootstrap-errors", "revival"];
const receipt = { release, complete: false, cases: [] };
let packageSha;
for (const mode of modes) {
	assert.deepEqual(Object.fromEntries(inputs.map((file) => [file, sha(path.join(source, file))])), frozen, "execution inputs changed during the gate");
	const startedAt = new Date().toISOString();
	const result = spawnSync(process.execPath, [path.join(source, "test/smoke/standalone-background.mjs"), binary, path.join(root, mode), mode], { cwd: source, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
	fs.writeFileSync(path.join(root, `${mode}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}`);
	receipt.cases.push({ mode, startedAt, exitCode: result.status, error: result.error?.message });
	fs.writeFileSync(path.join(root, "matrix.json"), JSON.stringify(receipt, null, 2));
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${mode} failed; inspect ${path.join(root, `${mode}.log`)}`);
	const identity = JSON.parse(fs.readFileSync(path.join(root, mode, "identity.json"), "utf8"));
	const currentPackageSha = sha(path.join(root, mode, identity.packed));
	packageSha ??= currentPackageSha;
	assert.equal(currentPackageSha, packageSha, "matrix modes used different packaged candidates");
	console.log(`PASS ${mode}`);
}
assert.deepEqual(Object.fromEntries(inputs.map((file) => [file, sha(path.join(source, file))])), frozen, "execution inputs changed during the gate");
receipt.complete = true;
receipt.packageSha256 = packageSha;
fs.writeFileSync(path.join(root, "matrix.json"), JSON.stringify(receipt, null, 2));
console.log(`PASS official ${release.version}: ${modes.length} modes; ${root}`);
