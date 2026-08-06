/**
 * Photon image processing wrapper.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that works in:
 * 1. Node.js (development, npm run build)
 * 2. Bun compiled binaries (standalone distribution)
 *
 * The challenge: photon-node's CJS entry uses fs.readFileSync(__dirname + '/photon_rs_bg.wasm')
 * which bakes the build machine's absolute path into Bun compiled binaries.
 *
 * Solution:
 * 1. Patch fs.readFileSync to redirect missing photon_rs_bg.wasm reads
 * 2. Copy photon_rs_bg.wasm next to the executable in build:binary
 */
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";
/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export declare function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null>;
//# sourceMappingURL=photon.d.ts.map