import { Container, SelectList } from "@earendil-works/pi-tui";
/**
 * Component that renders a show images selector with borders
 */
export declare class ShowImagesSelectorComponent extends Container {
    private selectList;
    constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void);
    getSelectList(): SelectList;
}
//# sourceMappingURL=show-images-selector.d.ts.map