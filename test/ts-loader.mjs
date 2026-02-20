// ESM loader hook: rewrite .js imports to .ts when the .js file doesn't exist
// but a .ts file does. This bridges the gap between source-level .js extension
// imports and the actual .ts files on disk.

import * as fs from "node:fs";
import * as path from "node:path";

export function resolve(specifier, context, nextResolve) {
  // Only intercept relative imports that end in .js
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const parentDir = context.parentURL
      ? path.dirname(new URL(context.parentURL).pathname.replace(/^\/([A-Z]:)/i, "$1"))
      : process.cwd();
    const jsPath = path.resolve(parentDir, specifier);
    const tsPath = jsPath.replace(/\.js$/, ".ts");
    
    if (!fs.existsSync(jsPath) && fs.existsSync(tsPath)) {
      const tsSpecifier = specifier.replace(/\.js$/, ".ts");
      return nextResolve(tsSpecifier, context);
    }
  }
  return nextResolve(specifier, context);
}
