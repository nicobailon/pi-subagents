import { Key, type KeyId } from "@earendil-works/pi-tui";

export const FLEET_OPEN_SHORTCUT: KeyId = Key.ctrlAlt("f");

export function formatShortcutLabel(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => {
			const normalized = part.trim().toLowerCase();
			if (normalized === "ctrl") return "Ctrl";
			if (normalized === "alt") return "Alt";
			if (normalized === "shift") return "Shift";
			if (normalized === "super") return "Super";
			return normalized.length === 1 ? normalized.toUpperCase() : part.trim();
		})
		.join("+");
}
