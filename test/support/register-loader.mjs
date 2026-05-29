/**
 * Register the .js → .ts loader hook for integration tests.
 *
 * Usage: node --import jiti/register --import ./test/support/register-loader.mjs --test test/integration/*.test.ts
 *
 * Handles two issues:
 * 1. Source files use .js import extensions (TypeScript ESM convention) but
 *    files on disk are .ts — the loader rewrites .js → .ts at resolve time.
 * 2. `jiti/register` transforms TypeScript syntax such as parameter
 *    properties that Node's strip-only loader cannot execute.
 */

import { register } from "node:module";

register(new URL("./ts-loader.mjs", import.meta.url));
