const RESERVED_ARGS = ["--mode", "-p", "--print", "--no-session", "--session"];

export function validatePiArgs(piArgs: string[]): void {
	for (const arg of piArgs) {
		for (const reserved of RESERVED_ARGS) {
			if (arg === reserved || arg.startsWith(`${reserved}=`)) {
				throw new Error(
					`piArgs conflict: "${arg}" is reserved (internal to subagent spawning). ` +
					`Reserved args: ${RESERVED_ARGS.join(", ")}`
				);
			}
		}
	}
}
