/**
 * Structural declarations for the host extension surface this plugin consumes.
 *
 * The host's own declarations live in `@oh-my-pi/pi-coding-agent`; a published
 * extension package cannot rely on resolving that package at runtime, and the
 * host validates registrations when `registerProvider`/`registerCommand` run.
 * Everything here mirrors the host types by name and shape, so a drift shows up
 * as a registration error rather than a silently ignored field.
 */

import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";

export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	/** Whether the model exposes a client-selectable thinking effort. */
	reasoning: boolean;
	thinking?: {
		mode: "effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort";
		efforts: readonly ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")[];
		defaultLevel?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		effortMap?: Partial<Record<"minimal" | "low" | "medium" | "high" | "xhigh" | "max", string>>;
	};
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

/** Credential handed back after an interactive sign-in. */
export interface OAuthCredentials {
	refresh: string;
	access: string;
	expires: number;
}

export interface OAuthLoginCallbacks {
	/** Show the sign-in URL to the user. */
	onAuth(info: { url: string; launchUrl?: string; instructions?: string }): void;
	/** Ask the user for a value; used here to name the account. */
	onPrompt(prompt: { message: string; placeholder?: string; allowEmpty?: boolean }): Promise<string>;
	signal?: AbortSignal;
}

export interface ProviderConfig {
	/** Display name for the provider in the picker (PI). */
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	/** Custom streaming entry point for a non-built-in API. */
	streamSimple?: (model: Model, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	models?: ProviderModelConfig[];
	/** Live catalog discovery (OMP); the host caches the result and keeps `models` as fallback. */
	fetchDynamicModels?: (apiKey: string | undefined) => Promise<readonly ProviderModelConfig[]>;
	/** Live catalog discovery (PI); the host passes a context this provider ignores. */
	refreshModels?: (context?: unknown) => Promise<readonly ProviderModelConfig[]>;
	/** Static headers for every request; unused, requests are built here. */
	headers?: Record<string, string>;
	oauth?: {
		name: string;
		/** The account is a paid subscription, not an API key (PI login UI). */
		isSubscription?: boolean;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		/** PI calls this when the stored credential looks expired. */
		refreshToken?(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials>;
		/** PI turns credentials into the provider api key; this provider ignores it. */
		getApiKey?(credentials: OAuthCredentials): string;
	};
}

export interface ExtensionCommandContext {
	hasUI: boolean;
	ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface ExtensionAPI {
	registerProvider(name: string, config: ProviderConfig): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		},
	): void;
	/** Event subscription; absent on hosts that only expose commands. */
	on?: (event: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void | Promise<void>) => void;
	/** Provider removal; optional because not every host exposes it. */
	unregisterProvider?: (name: string) => void;
}
