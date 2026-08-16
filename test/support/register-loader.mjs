/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles two issues:
 * 1. Source files use .js import extensions (TypeScript ESM convention) but
 *    files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * 2. Source stays within Node's erasable TypeScript syntax so the supported
 *    --experimental-strip-types path is sufficient.
 */

import { register } from "node:module";
import "./isolated-temp-root.mjs";

register(new URL("./ts-loader.mjs", import.meta.url));
