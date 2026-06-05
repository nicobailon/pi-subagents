import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../shared/types.ts";
import { WatchOverlay } from "./watch-overlay.ts";
import { WatchSelector } from "./watch-selector.ts";
import { buildWatchSections, flattenWatchTargets } from "./watch-tree.ts";
import type { WatchTarget } from "./watch-types.ts";

function resolveTarget(args: string, targets: WatchTarget[]): WatchTarget | undefined {
	const query = args.trim();
	if (!query) return undefined;
	return targets.find((target) => target.id === query || target.id.includes(query) || target.rootRunId === query || target.nestedRunId === query);
}

export function registerSubagentWatchCommand(pi: Pick<ExtensionAPI, "registerCommand">, state: SubagentState): void {
	pi.registerCommand("subagent-watch", {
		description: "Watch current-session async subagents in a read-only overlay",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/subagent-watch requires interactive UI.", "error");
				return;
			}

			const openOverlay = async (target: WatchTarget): Promise<void> => {
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WatchOverlay({
					tui,
					theme,
					target,
					onClose: () => done(undefined),
					onBack: () => {
						done(undefined);
						void openSelector();
					},
				}), { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } });
			};

			const openSelector = async (): Promise<void> => {
				const sections = buildWatchSections(state);
				await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new WatchSelector({
					tui,
					theme,
					sections,
					onClose: () => done(undefined),
					onSelect: (target) => {
						done(undefined);
						void openOverlay(target);
					},
				}), { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } });
			};

			const sections = buildWatchSections(state);
			const direct = resolveTarget(args, flattenWatchTargets(sections));
			if (direct) await openOverlay(direct);
			else await openSelector();
		},
	});
}
