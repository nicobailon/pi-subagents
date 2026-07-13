/**
 * force-structured-output.ts
 *
 * Rozszerzenie Pi ładujące się tylko przy pi --continue dla structured output.
 * Wymusza deterministyczne zawołanie structured_output przez tool_choice: "required".
 *
 * Działa tylko gdy ustawiona jest zmienna środowiskowa PI_ORCH_FORCE_STRUCTURED_OUTPUT.
 * Jeśli jej brak — rozszerzenie nic nie robi (no-op, pass-through).
 *
 * Wzorzec oparty na guaranteed-tool.ts, uproszczony:
 * - nie sprawdza historii sesji (zakładamy czysty pi --continue)
 * - jeden prompt, jedno wymuszone narzędzie, terminate: true
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCHEMA_ENV = "PI_ORCH_FORCE_STRUCTURED_OUTPUT";

export default function registerForceStructuredOutput(pi: ExtensionAPI): void {
	const schemaRaw = process.env[SCHEMA_ENV];
	if (!schemaRaw) return;

	let schema: Record<string, unknown>;
	try {
		schema = JSON.parse(schemaRaw);
	} catch {
		return; // Invalid JSON — no-op
	}

	pi.registerTool({
		name: "structured_output",
		label: "Structured Output",
		description:
			"Submit the required final structured output for this extraction step. " +
			"Must be called with data matching the provided JSON Schema. Terminates the session.",
		parameters: schema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: JSON.stringify(params, null, 2) }],
				terminate: true,
			};
		},
	});

	pi.on("before_provider_request", (_event, _ctx) => {
		const payload = _event.payload as Record<string, unknown>;
		return {
			...payload,
			tool_choice: "required",
			reasoning: { effort: "none" },
			tools: [
				{
					type: "function" as const,
					function: {
						name: "structured_output",
						description:
							"Submit the required final structured output. Must be called to complete this step.",
						parameters: schema,
					},
				},
			],
		};
	});
}
