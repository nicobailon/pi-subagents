/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and pi-ai Models.
 */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
type AuthStorageData = Record<string, Credential>;
type LockResult<T> = {
    result: T;
    next?: string;
};
export interface AuthStorageBackend {
    withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
    withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}
export declare class FileAuthStorageBackend implements AuthStorageBackend {
    private authPath;
    constructor(authPath?: string);
    private ensureParentDir;
    private ensureFileExists;
    private acquireLockSyncWithRetry;
    withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
    withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}
export declare class InMemoryAuthStorageBackend implements AuthStorageBackend {
    private value;
    withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
    withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}
/**
 * Credential storage backed by a JSON file.
 */
export declare class AuthStorage implements CredentialStore {
    private data;
    private storage;
    private constructor();
    static create(authPath?: string): AuthStorage;
    static fromStorage(storage: AuthStorageBackend): AuthStorage;
    static inMemory(data?: AuthStorageData): AuthStorage;
    private parseStorageData;
    /**
     * Reload credentials from storage.
     */
    reload(): void;
    read(provider: string): Promise<Credential | undefined>;
    modify(provider: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined>;
    delete(provider: string): Promise<void>;
    /** List credential metadata without resolving configured key values. */
    list(): Promise<readonly CredentialInfo[]>;
}
/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export declare function readStoredCredential(providerId: string, authPath?: string): Credential | undefined;
export {};
//# sourceMappingURL=auth-storage.d.ts.map