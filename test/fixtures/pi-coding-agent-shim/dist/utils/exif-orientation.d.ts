import type { PhotonImageType } from "./photon.ts";
type Photon = typeof import("@silvia-odwyer/photon-node");
export declare function applyExifOrientation(photon: Photon, image: PhotonImageType, originalBytes: Uint8Array): PhotonImageType;
export {};
//# sourceMappingURL=exif-orientation.d.ts.map