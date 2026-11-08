import assert from "node:assert/strict";
import test from "node:test";
import { extractReportedProgress } from "../../src/shared/reported-progress.ts";

test("extracts the trimmed first line from a progress update", () => {
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: "  Working on tests.\nMore detail" }), "Working on tests.");
});

test("strips a leading Progress prefix case-insensitively", () => {
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: "  pRoGrEsS: [3/3] Running tests\nDetails" }), "[3/3] Running tests");
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: "Progress:   " }), undefined);
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: "Checking progress: running tests" }), "Checking progress: running tests");
});

test("ignores unrelated tools and supervisor reasons", () => {
	assert.equal(extractReportedProgress("other_tool", { reason: "progress_update", message: "text" }), undefined);
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "need_decision", message: "text" }), undefined);
});

test("ignores a blank first line", () => {
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: " \ntext" }), undefined);
});

test("sanitizes terminal controls", () => {
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: "hello\u001b[31mred\u001b[0m" }), "hello red");
});

test("caps long input without parsing counters", () => {
	assert.equal(extractReportedProgress("contact_supervisor", { reason: "progress_update", message: "[2/3] " + "x".repeat(600) })?.length, 512);
});
