import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadHostPiCodingAgent } from "../../src/runs/shared/child-session.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../src/shared/utils.ts";

declare global {
	// eslint-disable-next-line no-var
	var __fakeHostSdkLoads: number | undefined;
}

function fakeHostRoot(base: string): string {
	const root = path.join(base, "fake-pi-coding-agent");
	fs.mkdirSync(path.join(root, "dist"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		version: "0.0.0-fake",
		type: "module",
		exports: { ".": { import: "./dist/index.js" } },
	}));
	fs.writeFileSync(path.join(root, "dist", "index.js"), [
		"globalThis.__fakeHostSdkLoads = (globalThis.__fakeHostSdkLoads ?? 0) + 1;",
		"export const __fakeHostSdk = true;",
		"",
	].join("\n"));
	return root;
}

describe("loadHostPiCodingAgent", () => {
	let tmp: string;
	let root: string;
	let previous: string | undefined;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fake-host-sdk-"));
		root = fakeHostRoot(tmp);
		previous = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = root;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		else process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = previous;
		delete globalThis.__fakeHostSdkLoads;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("imports the SDK entry from the override root", async () => {
		const mod = await loadHostPiCodingAgent() as { __fakeHostSdk?: unknown };
		assert.equal(mod.__fakeHostSdk, true);
	});

	it("keeps one host module instance across repeated loads", async () => {
		await loadHostPiCodingAgent();
		await loadHostPiCodingAgent();
		assert.equal(globalThis.__fakeHostSdkLoads, 1);
	});

	it("auto-discovers the host package when no override is set", async () => {
		delete process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
		const mod = await loadHostPiCodingAgent() as { createAgentSession?: unknown };
		assert.equal(typeof mod.createAgentSession, "function");
	});

	it("rethrows when the override root cannot be imported", async () => {
		const broken = path.join(tmp, "broken-pi-coding-agent");
		fs.mkdirSync(path.join(broken, "dist"), { recursive: true });
		fs.writeFileSync(path.join(broken, "package.json"), JSON.stringify({
			name: "@earendil-works/pi-coding-agent",
			version: "0.0.0-fake",
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		}));
		fs.writeFileSync(path.join(broken, "dist", "index.js"), "throw new Error('broken entry');");
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = broken;
		await assert.rejects(loadHostPiCodingAgent(), /broken entry/);
	});

	it("rejects an override root whose package name differs", async () => {
		const wrong = path.join(tmp, "wrong-pi-coding-agent");
		fs.mkdirSync(path.join(wrong, "dist"), { recursive: true });
		fs.writeFileSync(path.join(wrong, "package.json"), JSON.stringify({
			name: "some-other-package",
			version: "0.0.0-fake",
			type: "module",
			exports: { ".": { import: "./dist/index.js" } },
		}));
		fs.writeFileSync(path.join(wrong, "dist", "index.js"), "throw new Error('must not be imported');");
		process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = wrong;
		await assert.rejects(loadHostPiCodingAgent(), /expected "@earendil-works\/pi-coding-agent"/);
	});
});
