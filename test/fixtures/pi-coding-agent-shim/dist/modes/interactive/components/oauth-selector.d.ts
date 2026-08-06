import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@earendil-works/pi-ai";
import { Container, type Focusable } from "@earendil-works/pi-tui";
export type AuthSelectorProvider = {
    id: string;
    name: string;
    authType: "oauth" | "api_key";
    method?: ApiKeyAuth | OAuthAuth;
    status?: AuthCheck;
};
export declare function formatAuthSelectorProviderType(authType: AuthSelectorProvider["authType"]): string;
/**
 * Component that renders an auth provider selector
 */
export declare class OAuthSelectorComponent extends Container implements Focusable {
    private searchInput;
    private _focused;
    get focused(): boolean;
    set focused(value: boolean);
    private listContainer;
    private allProviders;
    private filteredProviders;
    private selectedIndex;
    private mode;
    private onSelectCallback;
    private onCancelCallback;
    private showAuthTypeLabels;
    constructor(mode: "login" | "logout", providers: AuthSelectorProvider[], onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void, onCancel: () => void, initialSearchInput?: string);
    private filterProviders;
    private updateList;
    private formatStatusIndicator;
    handleInput(keyData: string): void;
}
//# sourceMappingURL=oauth-selector.d.ts.map