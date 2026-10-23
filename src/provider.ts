/**
 * The Zed provider: turns one host completion request into a Zed
 * `/completions` call, rotates accounts when an attempt fails before anything
 * reaches the caller, and converts upstream deltas into host events.
 *
 * Failure policy mirrors the reference gateway:
 *   - 401, and 403 without a plan restriction, bench the account (auth);
 *   - 429 benches it briefly (rate limit);
 *   - 5xx, timeouts, and network faults bench only after three in a row;
 *   - request-level faults (400/404/405/413/422) are reported as-is, because
 *     replaying them on another account fails identically;
 *   - a 403 naming a plan restriction is model-level: the account stays healthy
 *     and the next account is tried.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	ToolCall,
	Usage,
} from "@oh-my-pi/pi-ai";

import { AccountStore, type AccountState, type FailureKind, type ProbeState } from "./accounts.ts";
import type { ProviderConfig, ProviderModelConfig } from "./host/api.ts";
import { normalizeHostContext } from "./host/context.ts";
import { createAssistantEventStream, type AssistantEventStream } from "./host/stream.ts";
import { asRecord } from "./json.ts";
import { costFor, ratesFor, recordTurn } from "./usage.ts";
import { loginToZed, openInBrowser } from "./zed/auth.ts";
import { readCachedCatalog, writeCachedCatalog } from "./zed/catalog.ts";
import { ZedHttpError, createZedTransport, extractModelIds, readCompletionStream, type ZedTransport } from "./zed/client.ts";
import { DEFAULT_GPT56_EFFORT, GPT56_EFFORTS, familyLimits, providerFamily, type ProviderFamily } from "./zed/models.ts";
import { buildZedRequestBody } from "./zed/request.ts";

function intEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Fallback for models without a published rate; known models use the Zed price table. */
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Reasoning levels offered for Zed-hosted GPT-5.6 and Sonnet 5. */
const EFFORT_LEVELS = [...GPT56_EFFORTS.filter((effort) => effort !== "none")] as ("low" | "medium" | "high" | "xhigh")[];

export interface ZedProviderDeps {
	store: AccountStore;
	transport: ZedTransport;
	fetchImpl?: typeof fetch;
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { ...ZERO_COST, total: 0 },
	};
}

function applyCost(model: Model, usage: Usage): void {
	const cost = model.cost;
	usage.cost.input = (cost.input / 1_000_000) * usage.input;
	usage.cost.output = (cost.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (cost.cacheRead / 1_000_000) * usage.cacheRead;
	usage.cost.cacheWrite = (cost.cacheWrite / 1_000_000) * usage.cacheWrite;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function mapStopReason(reason: string): StopReason | null {
	switch (reason) {
		case "tool_use":
		case "tool_calls":
			return "toolUse";
		case "length":
		case "max_tokens":
		case "max_output_tokens":
			return "length";
		case "":
			return null;
		default:
			return "stop";
	}
}

interface FailureClassification {
	/** Cooldown class, or null when the failure is not the account's fault. */
	kind: FailureKind | null;
	status: number;
	/** Replaying on another account cannot help. */
	requestLevel: boolean;
	/** HTTP 403 that named a plan restriction: model unavailable, account fine. */
	planRestricted: boolean;
	message: string;
}

const REQUEST_LEVEL_STATUSES = new Set([400, 404, 405, 413, 422]);

function classifyFailure(error: unknown): FailureClassification {
	if (error instanceof ZedHttpError) {
		const requestLevel = REQUEST_LEVEL_STATUSES.has(error.status);
		let kind: FailureKind | null;
		if (error.status === 401) kind = "auth";
		else if (error.status === 403) kind = error.planRestricted ? null : "auth";
		else if (error.status === 429) kind = "rate_limit";
		else if (requestLevel) kind = null;
		else kind = "transient";
		return { kind, status: error.status, requestLevel, planRestricted: error.planRestricted, message: error.message };
	}
	if (error instanceof Error && error.name === "AbortError") {
		return { kind: null, status: 0, requestLevel: false, planRestricted: false, message: "request aborted" };
	}
	return {
		kind: "transient",
		status: 0,
		requestLevel: false,
		planRestricted: false,
		message: error instanceof Error ? error.message : String(error),
	};
}

interface ToolBuilder {
	index: number;
	json: string;
}

/**
 * Stream one turn. Account rotation happens only while nothing has been
 * delivered, so a caller never sees a partial answer from one account
 * continued by another.
 */
export function streamZedTurn(
	model: Model,
	context: Context,
	options: SimpleStreamOptions,
	deps: ZedProviderDeps,
): AssistantEventStream {
	const stream = createAssistantEventStream();

	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const startedAt = performance.now();
		let firstTokenAt: number | undefined;
		let committed = false;
		let sawAny = false;
		let textIndex: number | undefined;
		let thinkingIndex: number | undefined;
		let activeTool: ToolBuilder | undefined;
		let upstreamStop: StopReason | null = null;
		let activeAccount: AccountState | null = null;
		let recorded = false;

		const pushStart = (): void => {
			if (committed) return;
			committed = true;
			stream.push({ type: "start", partial: output });
		};
		const endText = (): void => {
			if (textIndex === undefined) return;
			const block = output.content[textIndex];
			if (block?.type === "text") stream.push({ type: "text_end", contentIndex: textIndex, content: block.text, partial: output });
			textIndex = undefined;
		};
		const endThinking = (): void => {
			if (thinkingIndex === undefined) return;
			const block = output.content[thinkingIndex];
			if (block?.type === "thinking") {
				stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: block.thinking, partial: output });
			}
			thinkingIndex = undefined;
		};
		const endTool = (): void => {
			const tool = activeTool;
			activeTool = undefined;
			if (!tool) return;
			const block = output.content[tool.index];
			if (block?.type !== "toolCall") return;
			block.arguments = parseArguments(tool.json);
			stream.push({ type: "toolcall_end", contentIndex: tool.index, toolCall: block, partial: output });
		};
		const appendText = (text: string): void => {
			if (text.length === 0) return;
			endThinking();
			endTool();
			pushStart();
			if (textIndex === undefined) {
				output.content.push({ type: "text", text: "" });
				textIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
			}
			const block = output.content[textIndex];
			if (block?.type === "text") {
				block.text += text;
				stream.push({ type: "text_delta", contentIndex: textIndex, delta: text, partial: output });
			}
			firstTokenAt ??= performance.now();
		};
		const appendThinking = (text: string): void => {
			if (text.length === 0) return;
			endText();
			endTool();
			pushStart();
			if (thinkingIndex === undefined) {
				// Zed streams reasoning as summaries, never as signed thinking blocks.
				output.content.push({ type: "thinking", thinking: "", summary: true });
				thinkingIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
			}
			const block = output.content[thinkingIndex];
			if (block?.type === "thinking") {
				block.thinking += text;
				stream.push({ type: "thinking_delta", contentIndex: thinkingIndex, delta: text, partial: output });
			}
			firstTokenAt ??= performance.now();
		};
		const startTool = (id: string | null, name: string): void => {
			endText();
			endThinking();
			endTool();
			pushStart();
			const toolCall: ToolCall = { type: "toolCall", id: id ?? `zed_${output.content.length}`, name, arguments: {} };
			output.content.push(toolCall);
			activeTool = { index: output.content.length - 1, json: "" };
			stream.push({ type: "toolcall_start", contentIndex: activeTool.index, partial: output });
		};
		const appendToolArguments = (json: string): void => {
			if (!activeTool || json.length === 0) return;
			activeTool.json += json;
			const block = output.content[activeTool.index];
			if (block?.type === "toolCall") block.arguments = parseArguments(activeTool.json);
			stream.push({ type: "toolcall_delta", contentIndex: activeTool.index, delta: json, partial: output });
			firstTokenAt ??= performance.now();
		};
		const applyStop = (
			reason: string | null,
			usage: {
				inputTokens: number | null;
				outputTokens: number | null;
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
			} | null,
		): void => {
			if (reason !== null) upstreamStop = mapStopReason(reason) ?? upstreamStop;
			if (!usage) return;
			if (usage.inputTokens !== null) output.usage.input = usage.inputTokens;
			if (usage.outputTokens !== null) output.usage.output = usage.outputTokens;
			if (usage.cacheReadTokens !== undefined) output.usage.cacheRead = usage.cacheReadTokens;
			if (usage.cacheWriteTokens !== undefined) output.usage.cacheWrite = usage.cacheWriteTokens;
		};

		const settle = (): AssistantMessage => {
			endText();
			endThinking();
			endTool();
			let reason: StopReason = upstreamStop ?? "stop";
			if (reason === "stop" && output.content.some((block) => block.type === "toolCall")) reason = "toolUse";
			output.stopReason = reason;
			output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			applyCost(model, output.usage);
			if (!recorded) {
				recorded = true;
				if (activeAccount !== null && output.usage.totalTokens > 0) {
					recordTurn(deps.store.path, {
						ts: Date.now(),
						account: activeAccount.name,
						userId: activeAccount.userId,
						organizationId: activeAccount.organizationId,
						model: model.id,
						input: output.usage.input,
						output: output.usage.output,
						cacheRead: output.usage.cacheRead,
						cacheWrite: output.usage.cacheWrite,
						costUsd: costFor(model.id, output.usage),
					});
				}
			}
			output.duration = performance.now() - startedAt;
			if (firstTokenAt !== undefined) output.ttft = firstTokenAt - startedAt;
			return output;
		};

		try {
			const normalized = normalizeHostContext(context);
			const body = buildZedRequestBody(model.id, {
				systemPrompt: normalized.system,
				messages: normalized.messages,
				tools: normalized.tools,
			}, options);
			const accounts = deps.store.tryOrder();
			if (accounts.length === 0) {
				throw new Error("No Zed account is connected. Sign in with /login (provider Zed; OMP: omp login zed).");
			}

			let lastFailure: FailureClassification | undefined;
			for (const account of accounts) {
				if (options.signal?.aborted) break;
				activeAccount = account;
				try {
					const jwt = await deps.store.tokenFor(account, deps.fetchImpl, options.signal);
					const response = await deps.transport.completions(jwt, body, options.signal);
					// The transport reports non-2xx as a thrown ZedHttpError; a stub or
					// proxy transport may hand back the raw response instead.
					if (!response.ok) throw new ZedHttpError(response.status, await response.text());
					let ended = false;
					for await (const delta of readCompletionStream(response)) {
						switch (delta.kind) {
							case "text":
								appendText(delta.text);
								sawAny = true;
								break;
							case "thinking":
								appendThinking(delta.text);
								sawAny = true;
								break;
							case "tool_start":
								startTool(delta.id, delta.name);
								sawAny = true;
								break;
							case "tool_args":
								appendToolArguments(delta.json);
								break;
							case "tool_end":
								endTool();
								break;
							case "usage":
								applyStop(null, delta.usage);
								break;
							case "stop":
								applyStop(delta.reason, delta.usage);
								break;
							case "failure":
								throw new ZedHttpError(delta.status, delta.message);
							case "ended":
								ended = true;
								break;
						}
						if (ended) break;
					}
					if (!sawAny && !ended) throw new Error("Zed returned an empty stream");
					deps.store.markSuccess(account, 200);
					lastFailure = undefined;
					break;
				} catch (error) {
					const failure = classifyFailure(error);
					if (failure.kind !== null) deps.store.markFailure(account, failure.kind, failure.status);
					lastFailure = failure;
					// A committed turn already delivered content; never restart it elsewhere.
					if (committed || failure.requestLevel || options.signal?.aborted === true) break;
				}
			}
			if (lastFailure !== undefined) throw new Error(lastFailure.message);

			const finished = settle();
			const doneReason =
				finished.stopReason === "length" ? "length" : finished.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason: doneReason, message: finished });
			stream.end(finished);
		} catch (error) {
			const finished = settle();
			if (options.signal?.aborted === true) {
				finished.stopReason = "aborted";
				finished.errorMessage = "Turn aborted";
				stream.push({ type: "error", reason: "aborted", error: finished });
				stream.end();
				return;
			}
			finished.stopReason = "error";
			finished.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: finished });
			stream.end();
		}
	})();

	return stream;
}

function parseArguments(json: string): Record<string, unknown> {
	const parsed = asRecord(tryParse(json));
	return parsed ?? {};
}

function tryParse(json: string): unknown {
	if (json.trim().length === 0) return null;
	try {
		return JSON.parse(json);
	} catch {
		// Partial JSON while arguments stream; the next delta re-parses.
		return null;
	}
}

/**
 * Model declaration for the host. Every family has a request builder, so the
 * whole catalog is offered; window and output limits come from the highest
 * twin specification for the model, with env knobs (0 = unset) to override them
 * for plan experiments. Reasoning is advertised only where a builder actually
 * carries the control — Google and xAI requests have none, so offering a
 * selector would lie.
 */
export function zedModelConfig(id: string): ProviderModelConfig {
	const family = providerFamily(id);
	const limits = familyLimits(id);
	const contextOverride = intEnv("ZED2API_CONTEXT_WINDOW", 0);
	const config: ProviderModelConfig = {
		id,
		name: displayName(id),
		api: "zed-completions",
		reasoning: family === "anthropic" || family === "open_ai",
		input: ["text", "image"],
		cost: ratesFor(id) ?? ZERO_COST,
		contextWindow: contextOverride > 0 ? contextOverride : limits.contextWindow,
		maxTokens: maxTokensFor(family, limits.maxTokens),
	};
	if (config.reasoning) {
		config.thinking = {
			mode: "effort",
			efforts: EFFORT_LEVELS,
			defaultLevel: family === "anthropic" ? "xhigh" : DEFAULT_GPT56_EFFORT,
		};
	}
	return config;
}

/** Family output cap, unless the matching env override names a budget. */
function maxTokensFor(family: ProviderFamily, fallback: number): number {
	const override =
		family === "anthropic"
			? intEnv("ZED2API_CLAUDE_MAX_TOKENS", 0)
			: family === "open_ai"
				? intEnv("ZED2API_GPT_MAX_TOKENS", 0)
				: 0;
	return override > 0 ? override : fallback;
}

function displayName(id: string): string {
	if (id === "gpt-5.6") return "GPT-5.6 (Sol alias)";
	if (id === "gpt-5.6-sol") return "GPT-5.6 Sol";
	if (id === "gpt-5.6-terra") return "GPT-5.6 Terra";
	if (id === "gpt-5.6-luna") return "GPT-5.6 Luna";
	if (id === "gpt-5.5") return "GPT-5.5";
	if (id === "claude-sonnet-5") return "Claude Sonnet 5";
	return id;
}

/** Models the plugin offers before the live catalog resolves. */
export const STATIC_MODEL_IDS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6", "gpt-5.5", "claude-sonnet-5"];

export interface ProbeOutcome {
	state: ProbeState;
	detail: string;
	latencyMs: number;
	status: number;
}

/**
 * Liveness probe for one account: a 32-token GPT call asked to answer "OK",
 * the same model and budget the reference gateway probes with.
 */
export async function probeAccount(deps: ZedProviderDeps, account: AccountState): Promise<ProbeOutcome> {
	const startedAt = performance.now();
	const body = buildZedRequestBody(
		"gpt-5.6-luna",
		{ messages: [{ role: "user", content: "Reply only OK", timestamp: Date.now() }] },
		{ disableReasoning: true, maxTokens: 32 },
	);
	try {
		const jwt = await deps.store.tokenFor(account, deps.fetchImpl);
		const response = await deps.transport.completions(jwt, body);
		let text = "";
		for await (const delta of readCompletionStream(response)) {
			if (delta.kind === "text") text += delta.text;
		}
		const latencyMs = Math.round(performance.now() - startedAt);
		const detail = text.trim().length > 0 ? text.trim().slice(0, 60) : "stream completed";
		deps.store.markProbe(account, "healthy", latencyMs, null, 200);
		return { state: "healthy", detail, latencyMs, status: 200 };
	} catch (error) {
		const failure = classifyFailure(error);
		const latencyMs = Math.round(performance.now() - startedAt);
		const state: ProbeState =
			failure.status === 401 || (failure.status === 403 && !failure.planRestricted)
				? "auth_error"
				: failure.status === 429
					? "rate_limited"
					: "upstream_error";
		deps.store.markProbe(account, state, latencyMs, failure.kind, failure.status);
		return { state, detail: failure.message, latencyMs, status: failure.status };
	}
}

export interface ZedProviderInput {
	store: AccountStore;
	transport?: ZedTransport;
	fetchImpl?: typeof fetch;
}

/** The provider registration handed to `pi.registerProvider("zed", …)`. */
export function createZedProvider(input: ZedProviderInput): ProviderConfig {
	const transport = input.transport ?? createZedTransport({ fetchImpl: input.fetchImpl });
	const deps: ZedProviderDeps = { store: input.store, transport, fetchImpl: input.fetchImpl };
	// PI lists models without running a provider refresh, so the last live
	// catalog is cached and used as the initial list; a discovery refreshes it.
	const cachedIds = readCachedCatalog(input.store.current()?.userId);
	// Both hosts refresh the catalog on their own schedule, with different
	// fallback rules: OMP keeps the static list when discovery returns nothing,
	// while PI *replaces* the catalog with whatever `refreshModels` returns —
	// so there an empty answer must repeat the static list instead.
	const discoverModels = async (): Promise<readonly ProviderModelConfig[]> => {
		const account = input.store.current();
		if (!account) return [];
		try {
			const jwt = await input.store.tokenFor(account, input.fetchImpl);
			const ids = extractModelIds(await transport.models(jwt));
			writeCachedCatalog(account.userId, ids);
			return ids.map(zedModelConfig);
		} catch {
			return [];
		}
	};
	const staticModels = (cachedIds ?? STATIC_MODEL_IDS).map(zedModelConfig);
	const fetchDynamicModels = async (): Promise<readonly ProviderModelConfig[]> => discoverModels();
	const refreshModels = async (): Promise<readonly ProviderModelConfig[]> => {
		const discovered = await discoverModels();
		return discovered.length > 0 ? discovered : staticModels;
	};
	return {
		name: "Zed",
		api: "zed-completions",
		baseUrl: "https://cloud.zed.dev",
		// OAuth is the only login method: the account store owns the real
		// credential, and each request mints its own JWT. The credential the
		// host stores is a marker; getApiKey below supplies its access string.
		models: staticModels,
		// The host's declared return type is its concrete stream class; the stream
		// built here implements the consumed contract (async iteration, result(),
		// and the local-work surface watchdogs read) without resolving the host's
		// own modules at runtime.
		streamSimple: (model, context, options) =>
			streamZedTurn(model as Model, context, options ?? {}, deps) as unknown as AssistantMessageEventStream,
		fetchDynamicModels,
		refreshModels,
		oauth: {
			name: "Zed",
			isSubscription: true,
			login: async (callbacks) => {
				const requested = await callbacks.onPrompt({
					message: "Name this Zed account",
					placeholder: "default",
					allowEmpty: true,
				});
				const name = requested.trim() || "default";
				const credentials = await loginToZed({
					signal: callbacks.signal,
					onUrl: (url) => callbacks.onAuth({ url, instructions: "Sign in to Zed to finish connecting the account." }),
					openBrowser: openInBrowser,
				});
				const account = input.store.add(name, credentials.userId, credentials.credential);
				input.store.switchTo(name);
				try {
					await input.store.ensureOrganization(account);
					const jwt = await input.store.tokenFor(account, input.fetchImpl);
					writeCachedCatalog(account.userId, extractModelIds(await transport.models(jwt)));
				} catch {
					// The first token request resolves the organization again, and
					// the host refreshes the catalog on its own schedule.
				}
				return { refresh: "", access: `zed-account:${name}`, expires: Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 };
			},
			// Zed's stored credential does not expire: each request mints a
			// short-lived JWT, cached in the account store. PI's refresh hook
			// therefore hands the same credential back.
			refreshToken: async (credentials) => credentials,
			// PI uses this string as the provider api key. Requests here are
			// authenticated by the provider itself, so the value is inert.
			getApiKey: (credentials) => credentials.access,
		},
	};
}

export const ZED_PROVIDER_API: Api = "zed-completions";
