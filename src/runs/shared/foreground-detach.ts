import type { ForegroundResumeChild } from "../../shared/types.ts";

type DetachedChild = Pick<ForegroundResumeChild, "status" | "detachedReason">;

/** Legacy remembered detach records have no reason and originated from intercom. */
export function detachedChildrenRequireSupervisor(children: readonly DetachedChild[]): boolean {
	return children.some((child) => child.status === "detached" && child.detachedReason !== "user request");
}

export function detachedChildActivityLabel(child: DetachedChild): string {
	return child.detachedReason === "user request"
		? "working after user-requested detach"
		: "working after supervisor handoff";
}
