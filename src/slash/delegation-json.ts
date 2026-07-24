const MAX_JSON_DEPTH = 64;
const MAX_JSON_ENTRIES = 100_000;

export type BoundedJsonClone =
	| { ok: true; value: unknown; encodedBytes: number }
	| { ok: false; reason: "invalid" | "too_large" };

/** Clone plain JSON data without invoking getters or toJSON hooks. */
export function cloneJsonWithinByteLimit(input: unknown, maxBytes: number): BoundedJsonClone {
	let minimumBytes = 0;
	let entries = 0;
	const active = new WeakSet<object>();

	const addMinimumBytes = (bytes: number): void => {
		minimumBytes += bytes;
		if (minimumBytes > maxBytes) throw new RangeError("too_large");
	};

	const visit = (value: unknown, depth: number): unknown => {
		if (depth > MAX_JSON_DEPTH) throw new TypeError("invalid");
		if (value === null) {
			addMinimumBytes(4);
			return null;
		}
		if (typeof value === "boolean") {
			addMinimumBytes(value ? 4 : 5);
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw new TypeError("invalid");
			const encoded = JSON.stringify(Object.is(value, -0) ? 0 : value);
			addMinimumBytes(Buffer.byteLength(encoded, "utf8"));
			return Object.is(value, -0) ? 0 : value;
		}
		if (typeof value === "string") {
			// Quoting and escaping can only increase the encoded size.
			addMinimumBytes(Buffer.byteLength(value, "utf8") + 2);
			return value;
		}
		if (typeof value !== "object") throw new TypeError("invalid");

		const object = value as object;
		if (active.has(object)) throw new TypeError("invalid");
		active.add(object);
		try {
			const prototype = Object.getPrototypeOf(object);
			const keys = Reflect.ownKeys(object);
			if (Array.isArray(object)) {
				if (prototype !== Array.prototype) throw new TypeError("invalid");
				const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
				if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
					throw new TypeError("invalid");
				}
				const length = lengthDescriptor.value as number;
				addMinimumBytes(2 + Math.max(0, length - 1));
				const output: unknown[] = [];
				for (const key of keys) {
					if (typeof key === "symbol") throw new TypeError("invalid");
					if (key === "length") continue;
					if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) throw new TypeError("invalid");
				}
				for (let index = 0; index < length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
					if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("invalid");
					entries++;
					if (entries > MAX_JSON_ENTRIES) throw new TypeError("invalid");
					output.push(visit(descriptor.value, depth + 1));
				}
				return output;
			}

			if (prototype !== Object.prototype && prototype !== null) throw new TypeError("invalid");
			addMinimumBytes(2 + Math.max(0, keys.length - 1));
			const output: Record<string, unknown> = {};
			for (const key of keys) {
				if (typeof key === "symbol") throw new TypeError("invalid");
				const descriptor = Object.getOwnPropertyDescriptor(object, key);
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("invalid");
				entries++;
				if (entries > MAX_JSON_ENTRIES) throw new TypeError("invalid");
				addMinimumBytes(Buffer.byteLength(JSON.stringify(key), "utf8") + 1);
				Object.defineProperty(output, key, {
					value: visit(descriptor.value, depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			return output;
		} finally {
			active.delete(object);
		}
	};

	try {
		const value = visit(input, 0);
		const encoded = JSON.stringify(value);
		if (encoded === undefined) return { ok: false, reason: "invalid" };
		const encodedBytes = Buffer.byteLength(encoded, "utf8");
		if (encodedBytes > maxBytes) return { ok: false, reason: "too_large" };
		return { ok: true, value, encodedBytes };
	} catch (error) {
		return {
			ok: false,
			reason: error instanceof RangeError && error.message === "too_large" ? "too_large" : "invalid",
		};
	}
}
