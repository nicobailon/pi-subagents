export interface ListKeybindings {
	agentManagerNew: string[];
}

export const DEFAULT_LIST_KEYBINDINGS: ListKeybindings = {
	agentManagerNew: ["ctrl+n", "alt+n"],
};

export function normalizeListKeybindings(keybindings?: Partial<ListKeybindings>): ListKeybindings {
	return {
		agentManagerNew:
			keybindings?.agentManagerNew && keybindings.agentManagerNew.length > 0
				? [...keybindings.agentManagerNew]
				: [...DEFAULT_LIST_KEYBINDINGS.agentManagerNew],
	};
}

export function getPrimaryAgentManagerNewKeyLabel(keybindings: ListKeybindings): string {
	return keybindings.agentManagerNew[0] ?? DEFAULT_LIST_KEYBINDINGS.agentManagerNew[0]!;
}
