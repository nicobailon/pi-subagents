export type FallbackEntry = {
  providers: string[];
  model: string;
  thinking?: string; // Entry-specific thinking level (e.g., GPT→high, Opus→max)
};

export type ModelRequirement = {
  fallbackChain: FallbackEntry[];
  thinking?: string; // Default thinking level (used when entry doesn't specify one)
};

export const AGENT_MODEL_REQUIREMENTS: Record<string, ModelRequirement> = {
	"context-builder": {
		fallbackChain: [
			{ providers: [ "anthropic", "github-copilot", "opencode", "opencode-go" ], model: "claude-opus-4-7", thinking: "max" },
			{ providers: [ "opencode", "opencode-go" ], model: "kimi-k2.6" },
			{ providers: [ "opencode", "opencode-go" ], model: "kimi-k2.5" },
			{ providers: [ "openai-codex", "github-copilot", "opencode", "opencode-go" ], model: "gpt-5.5", thinking: "medium" },
			{ providers: [ "opencode", "opencode-go" ], model: "glm-5" },
			{ providers: [ "opencode", "opencode-go" ], model: "big-pickle" },
		],
	},
	oracle: {
		fallbackChain: [
			{ providers: [ "openai-codex", "github-copilot", "opencode", "opencode-go" ], model: "gpt-5.5", thinking: "high" },
			{ providers: [ "google", "github-copilot", "opencode", "opencode-go" ], model: "gemini-3.1-pro", thinking: "high" },
			{ providers: [ "anthropic", "github-copilot", "opencode", "opencode-go" ], model: "claude-opus-4-7", thinking: "max" },
			{ providers: [ "opencode", "opencode-go" ], model: "glm-5.1" },
		],
	},
	researcher: {
		fallbackChain: [
			{ providers: [ "openai-codex" ], model: "gpt-5.4-mini-fast" },
			{ providers: [ "opencode", "opencode-go" ], model: "qwen3.5-plus" },
			{ providers: [ "opencode", "opencode-go" ], model: "minimax-m2.7" },
			{ providers: [ "anthropic", "opencode", "opencode-go" ], model: "claude-haiku-4-5" },
			{ providers: [ "openai-codex", "opencode", "opencode-go" ], model: "gpt-5.4-nano" },
		],
	},
	scout: {
		fallbackChain: [
			{ providers: [ "openai-codex" ], model: "gpt-5.4-mini-fast" },
			{ providers: [ "opencode", "opencode-go" ], model: "qwen3.5-plus" },
			{ providers: [ "opencode", "opencode-go" ], model: "minimax-m2.7" },
			{ providers: [ "anthropic", "opencode", "opencode-go" ], model: "claude-haiku-4-5" },
			{ providers: [ "openai-codex", "opencode", "opencode-go" ], model: "gpt-5.4-nano" },
		],
	},
	planner: {
		fallbackChain: [
			{ providers: [ "anthropic", "github-copilot", "opencode", "opencode-go" ], model: "claude-opus-4-7", thinking: "max" },
			{ providers: [ "openai-codex", "github-copilot", "opencode", "opencode-go" ], model: "gpt-5.5", thinking: "high" },
			{ providers: [ "opencode", "opencode-go" ], model: "glm-5.1" },
			{ providers: [ "google", "github-copilot", "opencode", "opencode-go" ], model: "gemini-3.1-pro" },
		],
	},
	reviewer: {
		fallbackChain: [
			{ providers: [ "openai-codex", "github-copilot", "opencode", "opencode-go" ], model: "gpt-5.5", thinking: "xhigh" },
			{ providers: [ "anthropic", "github-copilot", "opencode", "opencode-go" ], model: "claude-opus-4-7", thinking: "max" },
			{ providers: [ "google", "github-copilot", "opencode", "opencode-go" ], model: "gemini-3.1-pro", thinking: "high" },
			{ providers: [ "opencode", "opencode-go" ], model: "glm-5.1" },
		],
	},
	worker: {
		fallbackChain: [
			{ providers: [ "anthropic", "github-copilot", "opencode", "opencode-go" ], model: "claude-sonnet-4-6" },
			{ providers: [ "opencode", "opencode-go" ], model: "kimi-k2.6" },
			{ providers: [ "openai-codex", "github-copilot", "opencode", "opencode-go" ], model: "gpt-5.5", thinking: "medium" },
			{ providers: [ "opencode", "opencode-go" ], model: "minimax-m2.7" },
			{ providers: [ "opencode", "opencode-go" ], model: "big-pickle" },
		],
	},
};
