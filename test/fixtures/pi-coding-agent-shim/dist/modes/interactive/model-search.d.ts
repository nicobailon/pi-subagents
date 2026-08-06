export interface ModelSearchItem {
    id: string;
    provider: string;
    name?: string;
}
export declare function getModelSearchText(item: ModelSearchItem): string;
/**
 * The /model selector search should rank exact provider-prefixed queries before proxy-provider IDs
 * like openrouter/openai/gpt-5, so keep the bare model ID out of the leading position.
 */
export declare function getModelSelectorSearchText(item: ModelSearchItem): string;
//# sourceMappingURL=model-search.d.ts.map