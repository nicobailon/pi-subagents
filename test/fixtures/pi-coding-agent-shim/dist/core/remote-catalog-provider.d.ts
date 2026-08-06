import type { Provider } from "@earendil-works/pi-ai";
export declare const REMOTE_CATALOG_REFRESH_INTERVAL_MS: number;
/** Add a persisted pi.dev catalog overlay to a static built-in provider. */
export declare function withRemoteCatalog(provider: Provider, catalogBaseUrl?: string, localCatalogUrl?: URL): Provider;
//# sourceMappingURL=remote-catalog-provider.d.ts.map