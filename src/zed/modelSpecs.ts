/**
 * Per-model limits taken from the built-in twin catalog.
 *
 * The upstream Zed catalog lists model ids only, so the plugin cannot ask it
 * for a context window. For each id below, the highest context window and
 * output ceiling declared by the same model on the built-in provider catalog
 * (OMP 18.12.2) is used. Gateway-wide output ceilings that apply to every
 * model are excluded: Gemini 4's 1,000,000-token value from one gateway is a
 * pool limit, not a model limit; its Google entries agree on 65,536.
 *
 * Unknown ids fall back to the family limits in `models.ts`.
 */
export interface ModelLimits {
	contextWindow: number;
	maxTokens: number;
}

export const MODEL_SPECS: Readonly<Record<string, ModelLimits>> = {
	// OpenAI GPT-5.x
	"gpt-5.6": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-5.6-sol": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-5.6-terra": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-5.6-luna": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-5.5": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-5.4": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-5.3-codex": { contextWindow: 272_000, maxTokens: 128_000 },
	"gpt-5.2": { contextWindow: 400_000, maxTokens: 128_000 },
	"gpt-5-mini": { contextWindow: 400_000, maxTokens: 128_000 },
	"gpt-5-nano": { contextWindow: 400_000, maxTokens: 128_000 },

	// OpenAI GPT-6.x
	"gpt-6.1-sol": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-6-sol": { contextWindow: 1_050_000, maxTokens: 128_000 },
	"gpt-6-luna": { contextWindow: 1_050_000, maxTokens: 128_000 },

	// Anthropic
	"claude-sonnet-5-5": { contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-sonnet-5": { contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-sonnet-4-6": { contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-sonnet-4-5": { contextWindow: 1_000_000, maxTokens: 64_000 },
	"claude-haiku-5-5": { contextWindow: 1_000_000, maxTokens: 128_000 },
	"claude-haiku-4-5": { contextWindow: 200_000, maxTokens: 64_000 },

	// Google Gemini
	"gemini-4-argon": { contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.8-flash": { contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.1-pro-preview": { contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3.5-flash": { contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-3-flash": { contextWindow: 1_048_576, maxTokens: 65_536 },
	"gemini-2.5-pro": { contextWindow: 1_048_576, maxTokens: 65_536 },

	// xAI
	"grok-4": { contextWindow: 256_000, maxTokens: 64_000 },
};

/** Exact twin spec for an id, or null when the family fallback applies. */
export function exactModelSpec(id: string): ModelLimits | null {
	return MODEL_SPECS[id] ?? null;
}
