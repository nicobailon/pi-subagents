import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
export declare class InMemoryCodingAgentModelsStore implements ModelsStore {
    private readonly entries;
    read(providerId: string): Promise<ModelsStoreEntry | undefined>;
    write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
    delete(providerId: string): Promise<void>;
}
/** Locked JSON-backed storage for dynamically refreshed provider catalogs. */
export declare class FileModelsStore implements ModelsStore {
    private readonly storage;
    constructor(path?: string);
    private parse;
    read(providerId: string): Promise<ModelsStoreEntry | undefined>;
    write(providerId: string, entry: ModelsStoreEntry): Promise<void>;
    delete(providerId: string): Promise<void>;
}
//# sourceMappingURL=models-store.d.ts.map