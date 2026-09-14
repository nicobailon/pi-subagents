import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveBunPiExecutable } from "../../src/runs/shared/pi-spawn.ts";

for (const [argv1, execPath] of [
	["/$bunfs/root/pi-native", "/opt/standalone/pi-native"],
	["B:/~BUN/root/pi-native.exe", "C:\\Program Files\\pi\\pi-native.exe"],
	["B:\\~BUN\\root\\pi-native.exe", "C:\\Program Files\\pi\\pi-native.exe"],
]) describe(`compiled background host detection: ${argv1}`, () => {
	const host = { execPath, argv1, bunVersion: "1.4.2", env: {} };

	it("uses the actual image even when renamed", () => {
		assert.equal(resolveBunPiExecutable(host), host.execPath);
	});

	it("honors a nonempty override, otherwise retaining the actual image", () => {
		assert.equal(resolveBunPiExecutable({ ...host, env: { PI_SUBAGENT_PI_BINARY: " /custom/pi " } }), "/custom/pi");
		assert.equal(resolveBunPiExecutable({ ...host, env: { PI_SUBAGENT_PI_BINARY: " " } }), host.execPath);
	});

	it("does not treat an ordinary Bun script or Node as a compiled host", () => {
		for (const entry of ["", "/work/script.ts", "B:/work/script.ts", "/$bunfs-other/pi", "B:/~BUN-other/pi.exe", "C:/~BUN/root/pi.exe", "/work/B:/~BUN/pi.exe"]) {
			assert.equal(resolveBunPiExecutable({ ...host, argv1: entry }), undefined, entry);
		}
		assert.equal(resolveBunPiExecutable({ ...host, bunVersion: "" }), undefined);
	});
});
