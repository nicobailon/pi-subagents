import { Container, SelectList } from "@earendil-works/pi-tui";
/**
 * Component that renders a theme selector
 */
export declare class ThemeSelectorComponent extends Container {
    private selectList;
    private onPreview;
    constructor(currentTheme: string, onSelect: (themeName: string) => void, onCancel: () => void, onPreview: (themeName: string) => void);
    getSelectList(): SelectList;
}
//# sourceMappingURL=theme-selector.d.ts.map