import { createRequire } from "node:module";
import type { Temporal } from "@js-temporal/polyfill";

const require = createRequire(import.meta.url);
let cachedTemporal: typeof Temporal | undefined;

function getTemporal(): typeof Temporal {
	return cachedTemporal ??= (require("@js-temporal/polyfill") as typeof import("@js-temporal/polyfill")).Temporal;
}

export const CALENDAR_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type CalendarWeekday = typeof CALENDAR_WEEKDAYS[number];
export type CalendarRule = { every: "day" | "week"; at: string; timezone: string; on?: CalendarWeekday[] };
export type CalendarOccurrence = { nextLocalDate: string; nextRunAt: string };
export type CalendarTrigger = CalendarRule & CalendarOccurrence & { kind: "calendar" };
const SEARCH_DAYS = 32;

export function normalizeCalendarRule(input: { every?: unknown; at?: unknown; timezone?: unknown; on?: unknown }): CalendarRule {
	if (input.every !== "day" && input.every !== "week") throw new Error("Calendar every must be 'day' or 'week'.");
	if (typeof input.at !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.at)) throw new Error("Calendar at must use HH:mm (00:00-23:59).");
	if (typeof input.timezone !== "string" || !input.timezone.trim() || /^[+-]/.test(input.timezone.trim())) throw new Error("Calendar timezone requires an IANA name, such as 'Asia/Taipei', or 'UTC'.");
	let timezone: string;
	try { timezone = new Intl.DateTimeFormat("en", { timeZone: input.timezone.trim() }).resolvedOptions().timeZone; }
	catch { throw new Error(`Invalid calendar timezone '${input.timezone}'. Use an IANA name or 'UTC'.`); }
	if (input.every === "day") {
		if (input.on !== undefined) throw new Error("Daily schedules do not accept on; use every:'week' with a weekday array.");
		return { every: "day", at: input.at, timezone };
	}
	if (!Array.isArray(input.on) || input.on.length === 0 || input.on.some((day) => !CALENDAR_WEEKDAYS.includes(day))) throw new Error("Weekly on must be a non-empty array of mon/tue/wed/thu/fri/sat/sun.");
	const selected = input.on;
	return { every: "week", at: input.at, timezone, on: CALENDAR_WEEKDAYS.filter((day) => selected.includes(day)) };
}

function localDate(value: string): Temporal.PlainDate {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Calendar nextLocalDate must use YYYY-MM-DD.");
	return getTemporal().PlainDate.from(value, { overflow: "reject" });
}

function referenceDate(rule: CalendarRule, reference: number): Temporal.PlainDate {
	return getTemporal().Instant.fromEpochMilliseconds(reference).toZonedDateTimeISO(rule.timezone).toPlainDate();
}

function occurrence(rule: CalendarRule, date: Temporal.PlainDate): CalendarOccurrence | undefined {
	if (rule.every === "week" && !rule.on!.includes(CALENDAR_WEEKDAYS[date.dayOfWeek - 1]!)) return undefined;
	const requested = date.toPlainDateTime(rule.at);
	const zoned = requested.toZonedDateTime(rule.timezone, { disambiguation: "earlier" });
	// Skip nonexistent times/dates. A repeated time uses its first instant only.
	if (!zoned.toPlainDateTime().equals(requested)) return undefined;
	return { nextLocalDate: date.toString(), nextRunAt: new Date(zoned.epochMilliseconds).toISOString() };
}

export function nextCalendarOccurrence(rule: CalendarRule, after: number, minimumDate?: string): CalendarOccurrence {
	let date = referenceDate(rule, after);
	if (minimumDate && getTemporal().PlainDate.compare(date, localDate(minimumDate)) < 0) date = localDate(minimumDate);
	for (let i = 0; i < SEARCH_DAYS; i++, date = date.add({ days: 1 })) {
		const candidate = occurrence(rule, date);
		if (candidate && Date.parse(candidate.nextRunAt) > after) return candidate;
	}
	throw new Error("No valid calendar occurrence within 32 local dates; check the timezone and rule.");
}

export function latestCalendarOccurrence(rule: CalendarRule, now: number, minimumDate: string): CalendarOccurrence | undefined {
	const floor = localDate(minimumDate);
	let date = referenceDate(rule, now);
	for (let i = 0; i < SEARCH_DAYS; i++, date = date.subtract({ days: 1 })) {
		if (getTemporal().PlainDate.compare(date, floor) < 0) return undefined;
		const candidate = occurrence(rule, date);
		if (candidate && Date.parse(candidate.nextRunAt) <= now) return candidate;
	}
	throw new Error("No valid calendar occurrence within 32 local dates; check the timezone and rule.");
}

export function calendarDateAfter(rule: CalendarRule, consumedAt: number, pendingDate: string): string {
	const consumed = referenceDate(rule, consumedAt);
	const pending = localDate(pendingDate);
	return (getTemporal().PlainDate.compare(consumed, pending) > 0 ? consumed : pending).add({ days: 1 }).toString();
}

/** Re-resolve the pending date using current timezone data, without consulting its UTC cache. */
export function restoreCalendarTrigger(input: CalendarTrigger): CalendarTrigger {
	const rule = normalizeCalendarRule(input);
	let date = localDate(input.nextLocalDate);
	if (rule.every === "week" && !rule.on!.includes(CALENDAR_WEEKDAYS[date.dayOfWeek - 1]!)) throw new Error("Calendar nextLocalDate is outside the selected weekdays.");
	if (typeof input.nextRunAt !== "string" || !Number.isFinite(Date.parse(input.nextRunAt))) throw new Error("Calendar nextRunAt must be a valid timestamp.");
	for (let i = 0; i < SEARCH_DAYS; i++, date = date.add({ days: 1 })) {
		const candidate = occurrence(rule, date);
		if (candidate) return { kind: "calendar", ...rule, ...candidate };
	}
	throw new Error("No valid pending calendar occurrence within 32 local dates.");
}
