export const MIN_SAFE_ASYNC_RUN_PREFIX_LENGTH = 8;
const FULL_ASYNC_RUN_ID_LENGTH = 36;

/** Full generated ids and longer exact identities never fall back to a root scan. */
export function canScanAsyncRunPrefix(id: string): boolean {
	return id.length >= MIN_SAFE_ASYNC_RUN_PREFIX_LENGTH && id.length < FULL_ASYNC_RUN_ID_LENGTH;
}
