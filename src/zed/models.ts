/**
 * Model routing rules, ported from the reference gateway.
 *
 * Zed exposes each model through a provider-specific wire dialect; the plugin
 * picks the dialect from the model id and rewrites ids the way the upstream
 * expects (notably: the bare `gpt-5.6` alias is not a model Zed serves, so it
 * routes to the real Sol variant).
 */

export type ProviderFamily = "anthropic" | "open_ai" | "google" | "x_ai";

/** Reasoning levels the Zed-hosted GPT-5.6 route accepts; anything else is a 400. */
export const GPT56_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export type Gpt56Effort = (typeof GPT56_EFFORTS)[number];

/** Effort used when the caller expresses no preference. */
export const DEFAULT_GPT56_EFFORT = "xhigh";

/** Upstream caps Sonnet 5 output here and rejects anything larger. */
export const ANTHROPIC_MAX_OUTPUT_TOKENS = 128_000;

/** Below this the OpenAI route rejects `max_output_tokens` outright (observed 16). */
export const GPT_UPSTREAM_MIN_OUTPUT_TOKENS = 16;
/** Local floor kept clear of the observed boundary. */
export const GPT_OUTPUT_TOKEN_SAFETY_FLOOR = GPT_UPSTREAM_MIN_OUTPUT_TOKENS * 2;
/** Reasoning efforts that need a large budget get this floor. */
export const GPT_REASONING_OUTPUT_FLOOR = 32_768;

export function providerFamily(model: string): ProviderFamily {
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt-")) return "open_ai";
	if (model.startsWith("gemini")) return "google";
	if (model.startsWith("grok")) return "x_ai";
	return "anthropic";
}

/**
 * Map a client-facing model id onto the id Zed actually serves. Unknown ids
 * pass through untouched so a newly published model is not silently rewritten.
 */
export function normalizeModelName(name: string): string {
	if (name.startsWith("gpt-5.6-sol")) return "gpt-5.6-sol";
	if (name.startsWith("gpt-5.6-terra")) return "gpt-5.6-terra";
	if (name.startsWith("gpt-5.6-luna")) return "gpt-5.6-luna";
	if (name.startsWith("gpt-5.6")) return "gpt-5.6-sol";
	if (name.startsWith("gpt-5.5")) return "gpt-5.5";
	if (name.startsWith("gpt-")) return "gpt-5.6-sol";
	if (name.startsWith("claude")) return "claude-sonnet-5";
	return name;
}

export function isGpt56(model: string): boolean {
	return model.startsWith("gpt-5.6");
}

export function isGpt55(model: string): boolean {
	return model.startsWith("gpt-5.5");
}

export function acceptsGpt56Effort(effort: string): effort is Gpt56Effort {
	return (GPT56_EFFORTS as readonly string[]).includes(effort);
}

/**
 * Whether Zed's Anthropic route drops the sampling knobs entirely. Anthropic
 * deprecated them for this model class and the upstream answers 400 when they
 * are present.
 */
export function rejectsSamplingParams(model: string): boolean {
	return model.startsWith("claude-sonnet-5");
}

/**
 * Effective reasoning effort for the OpenAI/Responses dialect. GPT-5.5 ignores
 * the client value; GPT-5.6 honours it when it is in the accepted set and
 * otherwise falls back to the default, exactly like the reference proxy.
 */
export function effectiveEffort(model: string, requested: string | null | undefined): Gpt56Effort | null {
	if (isGpt55(model)) return "xhigh";
	if (!isGpt56(model)) return null;
	if (requested && acceptsGpt56Effort(requested)) return requested;
	return DEFAULT_GPT56_EFFORT;
}

/**
 * Output budget clamp applied per family. A missing budget is left alone: the
 * upstream picks its own default.
 */
export function clampOutputBudget(model: string, requested: number | null, effort: string | null): number | null {
	if (requested === null) {
		return isGpt56(model) && effort !== null && (effort === "xhigh" || effort === "max")
			? GPT_REASONING_OUTPUT_FLOOR
			: null;
	}
	if (providerFamily(model) === "anthropic") return Math.min(requested, ANTHROPIC_MAX_OUTPUT_TOKENS);
	if (isGpt56(model) || isGpt55(model)) {
		if (effort === "xhigh" || effort === "max") return Math.max(requested, GPT_REASONING_OUTPUT_FLOOR);
		return Math.max(requested, GPT_OUTPUT_TOKEN_SAFETY_FLOOR);
	}
	return requested;
}

/**
 * Conservative per-family ceilings. The upstream catalog (`GET /models`) lists
 * ids only and carries no metadata, so these stand in for the window and
 * output cap of each family rather than a per-model measurement.
 */
export function familyLimits(model: string): { contextWindow: number; maxTokens: number } {
	switch (providerFamily(model)) {
		case "anthropic":
			return { contextWindow: 200_000, maxTokens: ANTHROPIC_MAX_OUTPUT_TOKENS };
		case "open_ai":
			return { contextWindow: 128_000, maxTokens: 32_768 };
		case "google":
			return { contextWindow: 1_048_576, maxTokens: 32_768 };
		case "x_ai":
			return { contextWindow: 262_144, maxTokens: 32_768 };
	}
}
