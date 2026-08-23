export const PI_SUBAGENT_EXTENSION_BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
export const MAX_EXTENSION_BINDING_NAMESPACES = 16;
export const MAX_EXTENSION_BINDINGS_BYTES = 16 * 1024;
export const MAX_EXTENSION_BINDINGS_DEPTH = 16;
export const MAX_EXTENSION_BINDINGS_PROPERTIES = 256;

const EXTENSION_BINDING_NAMESPACE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62})\/[1-9][0-9]{0,8}$/;

export type ExtensionBindingJson = null | boolean | number | string | ReadonlyArray<ExtensionBindingJson> | { readonly [key: string]: ExtensionBindingJson };
export type ExtensionBindings = Readonly<Record<string, ExtensionBindingJson>>;

export interface NormalizedExtensionBindings {
	value: ExtensionBindings;
	json: string;
}

function canonicalizeJson(value: unknown, path: string, depth: number, seen: Set<object>, propertyCount: { value: number }): ExtensionBindingJson {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers.`);
		return value;
	}
	if (typeof value !== "object") throw new Error(`${path} must contain only plain JSON values.`);
	if (depth > MAX_EXTENSION_BINDINGS_DEPTH) throw new Error(`${path} exceeds the maximum nesting depth of ${MAX_EXTENSION_BINDINGS_DEPTH}.`);
	if (seen.has(value)) throw new Error(`${path} must not contain cycles.`);
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const output: ExtensionBindingJson[] = [];
			for (let index = 0; index < value.length; index++) {
				if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${path} must not contain sparse arrays.`);
				output.push(canonicalizeJson(value[index], `${path}[${index}]`, depth + 1, seen, propertyCount));
			}
			return Object.freeze(output);
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must contain only plain JSON objects.`);
		if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${path} must not contain symbol keys.`);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const output: Record<string, ExtensionBindingJson> = {};
		for (const key of Object.keys(descriptors).sort()) {
			const descriptor = descriptors[key]!;
			if (!descriptor.enumerable || !("value" in descriptor)) throw new Error(`${path}.${key} must be an enumerable data property.`);
			propertyCount.value += 1;
			if (propertyCount.value > MAX_EXTENSION_BINDINGS_PROPERTIES) throw new Error(`extensionBindings exceeds ${MAX_EXTENSION_BINDINGS_PROPERTIES} total properties.`);
			Object.defineProperty(output, key, { value: canonicalizeJson(descriptor.value, `${path}.${key}`, depth + 1, seen, propertyCount), enumerable: true, writable: false, configurable: false });
		}
		return Object.freeze(output);
	} finally {
		seen.delete(value);
	}
}

export function normalizeExtensionBindings(input: unknown): NormalizedExtensionBindings | undefined {
	if (input === undefined) return undefined;
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("extensionBindings must be a plain JSON object.");
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("extensionBindings must be a plain JSON object.");
	const keys = Object.keys(input);
	if (keys.length > MAX_EXTENSION_BINDING_NAMESPACES) throw new Error(`extensionBindings supports at most ${MAX_EXTENSION_BINDING_NAMESPACES} namespaces.`);
	for (const key of keys) {
		if (!EXTENSION_BINDING_NAMESPACE.test(key)) throw new Error(`extensionBindings namespace '${key}' must use a package-like name followed by '/<positive-version>'.`);
	}
	const value = canonicalizeJson(input, "extensionBindings", 0, new Set(), { value: 0 }) as ExtensionBindings;
	const json = JSON.stringify(value);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > MAX_EXTENSION_BINDINGS_BYTES) throw new Error(`extensionBindings canonical JSON is ${bytes} bytes; maximum is ${MAX_EXTENSION_BINDINGS_BYTES}.`);
	return { value, json };
}

export function encodeExtensionBindings(input: ExtensionBindings | undefined): string | undefined {
	return input === undefined ? undefined : normalizeExtensionBindings(input)!.json;
}

export function omitExtensionBindingsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const { [PI_SUBAGENT_EXTENSION_BINDINGS_ENV]: _extensionBindings, ...sanitized } = env;
	return sanitized;
}
