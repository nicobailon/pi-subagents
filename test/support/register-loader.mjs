/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --import tsx --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Source files use .js import extensions (TypeScript ESM convention) but files
 * on disk are .ts. The loader rewrites .js → .ts at resolve time; tsx performs
 * the TypeScript transform consistently across supported Node versions.
 */

import { register } from "node:module";

register(new URL("./ts-loader.mjs", import.meta.url));
