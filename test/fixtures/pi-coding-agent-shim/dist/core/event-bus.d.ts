export interface EventBus {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export interface EventBusController extends EventBus {
    clear(): void;
}
export declare function createEventBus(): EventBusController;
//# sourceMappingURL=event-bus.d.ts.map