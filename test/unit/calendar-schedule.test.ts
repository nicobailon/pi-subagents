import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { latestCalendarOccurrence, nextCalendarOccurrence, normalizeCalendarRule, restoreCalendarTrigger } from "../../src/runs/background/calendar-schedule.ts";

describe("calendar occurrence calculation", () => {
	it("loads the polyfill only for calendar evaluation and reuses its synchronous module", () => {
		const moduleUrl = new URL("../../src/runs/background/calendar-schedule.ts", import.meta.url).href;
		const loader = `export async function resolve(specifier, context, next) {
			if (specifier === '@js-temporal/polyfill') throw new Error('Calendar polyfill must not be imported eagerly');
			return next(specifier, context);
		}`;
		const source = `
			import assert from 'node:assert/strict';
			import { createRequire } from 'node:module';
			const calendar = await import(${JSON.stringify(moduleUrl)});
			const require = createRequire(${JSON.stringify(moduleUrl)});
			const polyfillPath = require.resolve('@js-temporal/polyfill');
			assert.equal(require.cache[polyfillPath], undefined);
			const rule = calendar.normalizeCalendarRule({ every: 'day', at: '09:00', timezone: 'UTC' });
			assert.equal(require.cache[polyfillPath], undefined);
			const occurrence = calendar.nextCalendarOccurrence(rule, Date.parse('2026-10-02T00:00:00Z'));
			assert.equal(occurrence.nextRunAt, '2026-10-02T09:00:00.000Z');
			const loaded = require.cache[polyfillPath];
			assert.ok(loaded?.loaded);
			assert.deepEqual(calendar.restoreCalendarTrigger({ kind: 'calendar', ...rule, ...occurrence }), { kind: 'calendar', ...rule, ...occurrence });
			assert.equal(require.cache[polyfillPath], loaded);
		`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-loader", `data:text/javascript,${encodeURIComponent(loader)}`, "--input-type=module", "--eval", source], { encoding: "utf-8", timeout: 30_000 });
		assert.equal(child.status, 0, child.error?.message || child.stderr);
	});

	for (const [name, timezone, at, after, expected] of [
		["Taipei clock", "Asia/Taipei", "09:00", "2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z"],
		["strictly after", "Asia/Taipei", "09:00", "2026-10-02T01:00:00Z", "2026-10-03T01:00:00Z"],
		["spring gap", "America/New_York", "02:30", "2026-03-08T06:00:00Z", "2026-03-09T06:30:00Z"],
		["first fold instant", "America/New_York", "01:30", "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z"],
		["no second fold fire", "America/New_York", "01:30", "2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z"],
		["half-hour gap", "Australia/Lord_Howe", "02:15", "2026-10-03T14:00:00Z", "2026-10-04T15:15:00Z"],
		["half-hour fold", "Australia/Lord_Howe", "01:45", "2026-04-04T13:00:00Z", "2026-04-04T14:45:00Z"],
		["skipped date", "Pacific/Apia", "09:00", "2011-12-29T20:00:00Z", "2011-12-30T19:00:00Z"],
		["month boundary", "UTC", "09:00", "2026-01-31T09:00:00Z", "2026-02-01T09:00:00Z"],
		["leap day", "UTC", "09:00", "2028-02-28T09:00:00Z", "2028-02-29T09:00:00Z"],
	]) it(name!, () => {
		const rule = normalizeCalendarRule({ every: "day", timezone, at });
		assert.equal(nextCalendarOccurrence(rule, Date.parse(after!)).nextRunAt, new Date(expected!).toISOString());
	});

	it("normalizes weekly days and catches up after years without replaying every date", () => {
		const rule = normalizeCalendarRule({ every: "week", timezone: "Asia/Taipei", at: "09:00", on: ["fri", "mon", "mon"] });
		assert.deepEqual(rule.on, ["mon", "fri"]);
		assert.equal(nextCalendarOccurrence(rule, Date.parse("2026-10-02T01:00:00Z")).nextRunAt, "2026-10-05T01:00:00.000Z");
		assert.equal(latestCalendarOccurrence(rule, Date.parse("2030-01-01T00:00:00Z"), "2000-01-03")?.nextLocalDate, "2029-12-31");
	});
	it("uses the pending date to prevent repeating a served fold", () => {
		const rule = normalizeCalendarRule({ every: "day", timezone: "America/New_York", at: "01:30" });
		assert.equal(latestCalendarOccurrence(rule, Date.parse("2026-11-01T06:45:00Z"), "2026-11-02"), undefined);
	});
	it("restores the date independently of an obsolete UTC cache and skips a new gap", () => {
		const restored = restoreCalendarTrigger({ kind: "calendar", every: "day", timezone: "America/New_York", at: "02:30", nextLocalDate: "2026-03-08", nextRunAt: "2026-03-08T07:30:00Z" });
		assert.equal(restored.nextLocalDate, "2026-03-09");
		assert.equal(restored.nextRunAt, "2026-03-09T06:30:00.000Z");
	});
	it("rejects missing zones, fixed offsets, invalid clocks, weekdays and dates", () => {
		for (const override of [{ timezone: undefined }, { timezone: "+08:00" }, { timezone: "Invalid/Zone" }, { at: "9:00" }, { at: "24:00" }, { every: "day", on: ["mon"] }, { every: "week", on: [] }, { every: "week", on: "mon" }, { every: "week", on: ["MON"] }]) {
			assert.throws(() => normalizeCalendarRule({ every: "day", at: "09:00", timezone: "UTC", ...override }));
		}
		assert.throws(() => restoreCalendarTrigger({ kind: "calendar", every: "day", at: "09:00", timezone: "UTC", nextLocalDate: "2030-02-30", nextRunAt: "2030-03-01T09:00:00Z" }));
	});
});
