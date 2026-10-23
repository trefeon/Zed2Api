/**
 * Build the Zed `/completions` request body from a host completion request.
 *
 * Envelope, matching the reference gateway's `buildZedPayload`:
 *   {"thread_id":"<uuid4>","prompt_id":"<uuid4>","intent":"user_prompt",
 *    "provider":"<anthropic|open_ai|google|x_ai>","model":"<id>","provider_request":{…}}
 *
 * The inner payload follows one of the four dialects the reference proxy emits,
 * picked by model family: Anthropic for Claude, OpenAI Responses for GPT,
 * Gemini for Gemini and chat completions for Grok. All were derived from Zed's
 * own client traffic, and the upstream parser is strict about several fields,
 * so the rules below are not cosmetic:
 *   - `max_tokens` for Claude is capped at 128000 and defaults to 8192;
 *   - `temperature`/`top_p`/`top_k` are never sent for claude-sonnet-5;
 *   - thinking blocks are not replayed (the upstream rejects unsigned ones);
 *   - GPT output budgets are floored so the upstream does not answer 400;
 *   - Gemini takes the model id under `models/` and one `functionResponse` set
 *     per model turn.
 */

import type { Context, ImageContent, SimpleStreamOptions, Tool, ToolCall, ToolChoice } from "@oh-my-pi/pi-ai";

import {
	ANTHROPIC_MAX_OUTPUT_TOKENS,
	DEFAULT_GPT56_EFFORT,
	GPT_OUTPUT_TOKEN_SAFETY_FLOOR,
	GPT_REASONING_OUTPUT_FLOOR,
	clampOutputBudget,
	isGpt55,
	isGpt56,
	normalizeModelName,
	providerFamily,
	rejectsSamplingParams,
} from "./models.ts";

const ANTHROPIC_DEFAULT_MAX_TOKENS = 8192;

export interface ZedEnvelope {
	thread_id: string;
	prompt_id: string;
	intent: "user_prompt";
	provider: string;
	model: string;
	provider_request: Record<string, unknown>;
}

type JsonObject = Record<string, unknown>;

/** Zed expects real RFC 4122 v4 ids, distinct per request. */
function uuid4(): string {
	return crypto.randomUUID();
}

function textBlock(text: string): JsonObject {
	return { type: "text", text };
}

function imageBlock(image: ImageContent): JsonObject {
	return { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } };
}

/** Host effort → the effort letters Zed's Claude route accepts under output_config. */
function anthropicEffort(effort: string | undefined, disableReasoning: boolean | undefined): string | null {
	if (disableReasoning) return "low";
	switch (effort) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "xhigh":
			return "xhigh";
		case "max":
			return "xhigh";
		default:
			return null;
	}
}

/** Host effort → GPT-5.6 effort, clamped to the levels the upstream serves. */
function responsesEffort(model: string, effort: string | undefined, disableReasoning: boolean | undefined): string {
	if (disableReasoning) return "none";
	// GPT-5.5 ignores the client value upstream and is pinned to xhigh.
	if (isGpt55(model)) return "xhigh";
	if (!isGpt56(model)) return effort ?? DEFAULT_GPT56_EFFORT;
	if (effort === undefined) return DEFAULT_GPT56_EFFORT;
	if (effort === "minimal") return "low";
	if (effort === "max") return "xhigh";
	return effort;
}

function sanitizeAnthropicTool(tool: Tool): JsonObject | null {
	const name = tool.name?.trim();
	if (!name) return null;
	const schema = tool.parameters;
	return {
		name,
		description: tool.description || "",
		input_schema: typeof schema === "object" && schema !== null ? schema : { type: "object", properties: {} },
	};
}

interface AnthropicToolChoice {
	value: JsonObject | string | null;
	namedTool: string | null;
}

function anthropicToolChoice(choice: ToolChoice | undefined): AnthropicToolChoice {
	if (!choice) return { value: null, namedTool: null };
	if (choice === "auto") return { value: { type: "auto" }, namedTool: null };
	if (choice === "required" || choice === "any") return { value: { type: "any" }, namedTool: null };
	if (choice === "none") return { value: null, namedTool: null };
	if (choice.type === "computer") return { value: null, namedTool: null };
	if ("function" in choice) return { value: { type: "tool", name: choice.function.name }, namedTool: choice.function.name };
	return { value: { type: "tool", name: choice.name }, namedTool: choice.name };
}

function assistantBlocks(toolCalls: ToolCall[], text: string, hasText: boolean): JsonObject[] {
	const blocks: JsonObject[] = [];
	if (hasText && text.length > 0) blocks.push(textBlock(text));
	for (const call of toolCalls) {
		blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
	}
	return blocks;
}

/**
 * Anthropic-dialect provider_request. Mirrors `buildAnthropicRequest`:
 * message-level system/developer text is hoisted into `system`, unsupported
 * content variants (thinking, redacted_thinking, document) are dropped, and
 * tool results are normalized so a missing `content` becomes `""`.
 */
export function buildAnthropicProviderRequest(
	model: string,
	context: Context,
	options: SimpleStreamOptions = {},
): JsonObject {
	const messages: JsonObject[] = [];
	const systemTexts: string[] = [...(context.systemPrompt ?? [])];

	for (const message of context.messages) {
		if (message.role === "user") {
			const blocks: JsonObject[] = [];
			if (typeof message.content === "string") {
				blocks.push(textBlock(message.content));
			} else {
				for (const block of message.content) {
					if (block.type === "text") blocks.push(textBlock(block.text));
					else if (block.type === "image") blocks.push(imageBlock(block));
				}
			}
			if (blocks.length === 0) blocks.push(textBlock(""));
			messages.push({ role: "user", content: blocks });
			continue;
		}
		if (message.role === "assistant") {
			const toolCalls: ToolCall[] = [];
			let text = "";
			for (const block of message.content) {
				if (block.type === "text") text += block.text;
				else if (block.type === "toolCall") toolCalls.push(block);
			}
			const blocks = assistantBlocks(toolCalls, text, text.length > 0);
			if (blocks.length === 0) continue;
			messages.push({ role: "assistant", content: blocks });
			continue;
		}
		if (message.role === "toolResult") {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push(block.text);
			}
			messages.push({
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: message.toolCallId,
						content: parts.join("\n"),
						is_error: message.isError,
					},
				],
			});
			continue;
		}
		if (message.role === "developer") {
			if (typeof message.content === "string") systemTexts.push(message.content);
		}
	}

	const thinkingEffort = anthropicEffort(options.reasoning, options.disableReasoning);
	const requested = options.maxTokens ?? null;
	const maxTokens =
		requested === null ? ANTHROPIC_DEFAULT_MAX_TOKENS : Math.min(Math.max(1, Math.floor(requested)), ANTHROPIC_MAX_OUTPUT_TOKENS);

	const request: JsonObject = { model, messages, max_tokens: maxTokens };

	if (systemTexts.length > 0) {
		request.system = systemTexts.map((text) => textBlock(text));
	}
	if (!rejectsSamplingParams(model) && typeof options.temperature === "number") {
		request.temperature = options.temperature;
	}
	const stops = (options.stopSequences ?? []).filter((stop) => typeof stop === "string" && stop.trim().length > 0);
	if (stops.length > 0) request.stop_sequences = stops;

	if (context.tools && context.tools.length > 0) {
		const choice = anthropicToolChoice(options.toolChoice);
		const tools = context.tools
			.map((tool) => sanitizeAnthropicTool(tool))
			.filter((tool): tool is JsonObject => tool !== null)
			.filter((tool) => choice.namedTool === null || tool.name === choice.namedTool);
		if (tools.length > 0) request.tools = tools;
		if (choice.value !== null) request.tool_choice = choice.value;
	}
	if (thinkingEffort !== null) request.output_config = { effort: thinkingEffort };

	return request;
}

function responsesTextPart(text: string, role: "user" | "assistant" | "system"): JsonObject {
	return { type: role === "assistant" ? "output_text" : "input_text", text };
}

function inputImage(image: ImageContent): JsonObject {
	return { type: "input_image", image_url: `data:${image.mimeType};base64,${image.data}` };
}

/**
 * OpenAI Responses-dialect provider_request. Mirrors `buildOpenAIRequest`
 * (chat-history branch) plus the reasoning and budget rules:
 * assistant text becomes an `output_text` message, tool calls become
 * `function_call` items, tool results become `function_call_output`, and
 * `reasoning.summary` is always requested so thinking summaries stream back.
 */
export function buildResponsesProviderRequest(
	model: string,
	context: Context,
	options: SimpleStreamOptions = {},
): JsonObject {
	const input: JsonObject[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			const content: JsonObject[] = [];
			if (typeof message.content === "string") {
				content.push(responsesTextPart(message.content, "user"));
			} else {
				for (const block of message.content) {
					if (block.type === "text") content.push(responsesTextPart(block.text, "user"));
					else if (block.type === "image") content.push(inputImage(block));
				}
			}
			if (content.length === 0) content.push(responsesTextPart("", "user"));
			input.push({ type: "message", role: "user", content });
			continue;
		}
		if (message.role === "assistant") {
			const text: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
			}
			if (text.length > 0) {
				input.push({ type: "message", role: "assistant", content: [responsesTextPart(text.join(""), "assistant")] });
			}
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				input.push({
					type: "function_call",
					call_id: block.id,
					name: block.name,
					arguments: JSON.stringify(block.arguments ?? {}),
				});
			}
			continue;
		}
		if (message.role === "toolResult") {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push(block.text);
			}
			input.push({ type: "function_call_output", call_id: message.toolCallId, output: parts.join("\n") });
		}
	}

	const effort = responsesEffort(model, options.reasoning, options.disableReasoning);
	const budget = clampOutputBudget(model, options.maxTokens ?? null, effort);

	const request: JsonObject = { model, stream: true, input };
	const instructionText = (context.systemPrompt ?? []).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	if (instructionText.length > 0) request.instructions = instructionText.join("\n\n");

	if (context.tools && context.tools.length > 0) {
		const choice = resolveToolChoice(options.toolChoice);
		const tools = context.tools
			.filter((tool) => tool.name.trim().length > 0)
			.filter((tool) => choice.named === null || tool.name === choice.named)
			.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description || "",
				parameters:
					typeof tool.parameters === "object" && tool.parameters !== null
						? tool.parameters
						: { type: "object", properties: {} },
			}));
		if (tools.length > 0) {
			request.tools = tools;
			request.tool_choice = choice.required ? "required" : choice.none ? "none" : "auto";
		}
	}

	request.reasoning = { effort, summary: "detailed" };
	if (budget !== null) {
		// The upstream rejects budgets under its minimum, and reasoning-driven
		// turns need room for thinking, so both floors are applied here.
		request.max_output_tokens = Math.max(budget, effort === "xhigh" || effort === "max" ? GPT_REASONING_OUTPUT_FLOOR : GPT_OUTPUT_TOKEN_SAFETY_FLOOR);
	}

	return request;
}

/**
 * Host tool choice → what the OpenAI Responses dialect can express: a
 * `required`/`none`/`auto` hint plus, when a specific tool was named, that
 * name (the tool list is narrowed to it, which is how the reference proxy
 * carries a named choice upstream).
 */
function resolveToolChoice(choice: ToolChoice | undefined): { required: boolean; none: boolean; named: string | null } {
	if (choice === undefined || choice === "auto") return { required: false, none: false, named: null };
	if (choice === "required" || choice === "any") return { required: true, none: false, named: null };
	if (choice === "none") return { required: false, none: true, named: null };
	if (typeof choice === "object" && choice !== null) {
		if (choice.type === "function") {
			// The host accepts both the flat and the nested function-choice shape.
			return "function" in choice
				? { required: true, none: false, named: choice.function.name }
				: { required: true, none: false, named: choice.name };
		}
		if (choice.type === "tool") return { required: true, none: false, named: choice.name };
	}
	return { required: false, none: false, named: null };
}

/** Gemini rejects a declaration without a schema, so a missing one becomes an empty object schema. */
function schemaObject(schema: unknown): JsonObject {
	return typeof schema === "object" && schema !== null ? (schema as JsonObject) : { type: "object", properties: {} };
}

/**
 * Google (Gemini) dialect provider_request. Mirrors `buildGoogleRequest`: the
 * model id is namespaced under `models/`, the system prompt becomes
 * `systemInstruction`, and tools become `functionDeclarations`. That reference
 * forwarded text only, but history replay needs the whole conversation, so
 * images, tool calls and tool results are translated too.
 *
 * Gemini requires every `functionResponse` answering one model turn to travel
 * in a single user content, so consecutive tool results are buffered and
 * flushed as one entry.
 */
export function buildGoogleProviderRequest(
	model: string,
	context: Context,
	options: SimpleStreamOptions = {},
): JsonObject {
	const contents: JsonObject[] = [];
	const pendingToolParts: JsonObject[] = [];
	const flushToolResults = (): void => {
		if (pendingToolParts.length === 0) return;
		contents.push({ role: "user", parts: pendingToolParts.splice(0) });
	};

	for (const message of context.messages) {
		if (message.role === "user") {
			flushToolResults();
			const parts: JsonObject[] = [];
			if (typeof message.content === "string") {
				parts.push({ text: message.content });
			} else {
				for (const block of message.content) {
					if (block.type === "text") parts.push({ text: block.text });
					else if (block.type === "image") parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
				}
			}
			if (parts.length === 0) parts.push({ text: "" });
			contents.push({ role: "user", parts });
			continue;
		}
		if (message.role === "assistant") {
			flushToolResults();
			const parts: JsonObject[] = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push({ text: block.text });
				else if (block.type === "toolCall") {
					parts.push({ functionCall: { name: block.name, args: block.arguments ?? {} } });
				}
			}
			if (parts.length === 0) continue;
			contents.push({ role: "model", parts });
			continue;
		}
		if (message.role === "toolResult") {
			const text: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
			}
			pendingToolParts.push({
				functionResponse: { name: message.toolName, response: { result: text.join("\n") } },
			});
		}
	}
	flushToolResults();

	const generationConfig: JsonObject = { candidateCount: 1 };
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) {
		const budget = clampOutputBudget(model, options.maxTokens, null);
		if (budget !== null) generationConfig.maxOutputTokens = budget;
	}
	generationConfig.stopSequences = [];

	const request: JsonObject = { model: `models/${model}`, generationConfig };

	const systemText = (context.systemPrompt ?? [])
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.join("\n\n");
	if (systemText.length > 0) request.systemInstruction = { parts: [{ text: systemText }] };

	if (context.tools && context.tools.length > 0) {
		const choice = resolveToolChoice(options.toolChoice);
		const declarations = context.tools
			.filter((tool) => tool.name.trim().length > 0)
			.map((tool) => ({
				name: tool.name,
				description: tool.description || "",
				parameters: schemaObject(tool.parameters),
			}));
		if (declarations.length > 0) {
			request.tools = [{ functionDeclarations: declarations }];
			const functionCallingConfig: JsonObject = { mode: choice.none ? "NONE" : choice.required ? "ANY" : "AUTO" };
			if (choice.named !== null) functionCallingConfig.allowedFunctionNames = [choice.named];
			request.toolConfig = { functionCallingConfig };
		}
	}

	request.contents = contents;
	return request;
}

/**
 * xAI (Grok) dialect provider_request: the OpenAI chat-completions shape
 * `buildXAIRequest` emits, completed with the tool and image translations that
 * reference left out. No thinking/reasoning fields are sent; this dialect has
 * none the upstream accepts.
 */
export function buildXaiProviderRequest(
	model: string,
	context: Context,
	options: SimpleStreamOptions = {},
): JsonObject {
	const messages: JsonObject[] = [];
	const systemText = (context.systemPrompt ?? [])
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.join("\n\n");
	if (systemText.length > 0) messages.push({ role: "system", content: systemText });

	for (const message of context.messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				messages.push({ role: "user", content: message.content });
				continue;
			}
			const parts: JsonObject[] = [];
			const text: string[] = [];
			let hasImage = false;
			for (const block of message.content) {
				if (block.type === "text") {
					text.push(block.text);
					parts.push({ type: "text", text: block.text });
				} else if (block.type === "image") {
					hasImage = true;
					parts.push({
						type: "image_url",
						image_url: { url: `data:${block.mimeType};base64,${block.data}` },
					});
				}
			}
			messages.push(hasImage ? { role: "user", content: parts } : { role: "user", content: text.join("\n") });
			continue;
		}
		if (message.role === "assistant") {
			const text: string[] = [];
			const toolCalls: JsonObject[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
				else if (block.type === "toolCall") {
					toolCalls.push({
						id: block.id,
						type: "function",
						function: { name: block.name, arguments: JSON.stringify(block.arguments ?? {}) },
					});
				}
			}
			if (text.length === 0 && toolCalls.length === 0) continue;
			const entry: JsonObject = { role: "assistant", content: text.length > 0 ? text.join("") : null };
			if (toolCalls.length > 0) entry.tool_calls = toolCalls;
			messages.push(entry);
			continue;
		}
		if (message.role === "toolResult") {
			const text: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") text.push(block.text);
			}
			messages.push({ role: "tool", tool_call_id: message.toolCallId, content: text.join("\n") });
		}
	}

	const request: JsonObject = { model, stream: true, temperature: options.temperature ?? 1.0, messages };
	const budget = clampOutputBudget(model, options.maxTokens ?? null, null);
	if (budget !== null) request.max_tokens = budget;

	if (context.tools && context.tools.length > 0) {
		const choice = resolveToolChoice(options.toolChoice);
		const tools = context.tools
			.filter((tool) => tool.name.trim().length > 0)
			.map((tool) => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description || "",
					parameters: schemaObject(tool.parameters),
				},
			}));
		if (tools.length > 0) {
			request.tools = tools;
			request.tool_choice =
				choice.named !== null
					? { type: "function", function: { name: choice.named } }
					: choice.none
						? "none"
						: choice.required
							? "required"
							: "auto";
		}
	}

	return request;
}

/** Wrap a provider_request in the envelope Zed expects. */
export function buildZedEnvelope(model: string, providerRequest: JsonObject): ZedEnvelope {
	return {
		thread_id: uuid4(),
		prompt_id: uuid4(),
		intent: "user_prompt",
		provider: providerFamily(model),
		model,
		provider_request: providerRequest,
	};
}

/** Full request body for one attempt, choosing the dialect by model family. */
export function buildZedRequestBody(
	requestedModel: string,
	context: Context,
	options: SimpleStreamOptions = {},
): ZedEnvelope {
	const model = normalizeModelName(requestedModel);
	let providerRequest: JsonObject;
	switch (providerFamily(model)) {
		case "open_ai":
			providerRequest = buildResponsesProviderRequest(model, context, options);
			break;
		case "google":
			providerRequest = buildGoogleProviderRequest(model, context, options);
			break;
		case "x_ai":
			providerRequest = buildXaiProviderRequest(model, context, options);
			break;
		default:
			providerRequest = buildAnthropicProviderRequest(model, context, options);
	}
	return buildZedEnvelope(model, providerRequest);
}
