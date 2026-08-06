declare module "@earendil-works/pi-agent-core" {
	interface AgentToolResult<T> {
		/** Runtime error flag emitted and rendered by pi tool execution. */
		isError?: boolean;
	}
}

export {};
