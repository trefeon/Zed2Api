/**
 * Request construction: the envelope Zed expects and the four provider_request
 * dialects, including the sanitization rules the upstream parser enforces.
 */

import { describe, expect, test } from "bun:test";
import type { Context, SimpleStreamOptions, Tool } from "@oh-my-pi/pi-ai";

import { NO_USAGE, effort } from "./fixtures.ts";

import { familyLimits } from "../src/zed/models.ts";
import { buildZedRequestBody } from "../src/zed/request.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function userContext(text = "ping", extra: Context["messages"] = []): Context {
	return { systemPrompt: ["System prompt"], messages: [{ role: "user", content: text, timestamp: 1 }, ...extra] };
}

function providerRequest(model: string, context: Context, options: SimpleStreamOptions = {}): Record<string, unknown> {
	return buildZedRequestBody(model, context, options).provider_request;
}

const TOOLS: Tool[] = [
	{ name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
];

describe("envelope", () => {
	test("carries fresh UUIDv4 ids, the user_prompt intent, and the family", () => {
		const first = buildZedRequestBody("gpt-5.6-sol", userContext());
		const second = buildZedRequestBody("gpt-5.6-sol", userContext());
		expect(first.thread_id).toMatch(UUID_V4);
		expect(first.prompt_id).toMatch(UUID_V4);
		expect(first.thread_id).not.toBe(second.thread_id);
		expect(first.prompt_id).not.toBe(first.thread_id);
		expect(first.intent).toBe("user_prompt");
		expect(first.provider).toBe("open_ai");
		expect(first.model).toBe("gpt-5.6-sol");
		expect(buildZedRequestBody("claude-sonnet-5", userContext()).provider).toBe("anthropic");
	});

	test("normalizes aliases the upstream does not serve", () => {
		expect(buildZedRequestBody("gpt-5.6", userContext()).model).toBe("gpt-5.6-sol");
		expect(buildZedRequestBody("claude-3.7", userContext()).model).toBe("claude-sonnet-5");
	});
});

describe("anthropic dialect", () => {
	test("hoists the system prompt and caps max_tokens", () => {
		const request = providerRequest("claude-sonnet-5", userContext(), { maxTokens: 1_000_000 });
		expect(request.model).toBe("claude-sonnet-5");
		expect(request.max_tokens).toBe(128_000);
		expect(request.system).toEqual([{ type: "text", text: "System prompt" }]);
	});

	test("defaults the output budget and drops sampling params for Sonnet 5", () => {
		const request = providerRequest("claude-sonnet-5", userContext(), { temperature: 0.7, topP: 0.9 });
		expect(request.max_tokens).toBe(8192);
		expect(request.temperature).toBeUndefined();
		expect(request.top_p).toBeUndefined();
	});

	test("keeps temperature for a model the upstream still accepts it on", () => {
		// Claude ids normalize to Sonnet 5, whose upstream rejects sampling
		// params; an unlisted id reaches the same dialect untouched.
		expect(providerRequest("mistral-large", userContext(), { temperature: 0.3 }).temperature).toBe(0.3);
	});

	test("sanitizes tools and trims blank stop sequences", () => {
		const request = providerRequest("claude-sonnet-5", userContext(), {
			stopSequences: ["STOP", "   ", ""],
		});
		expect(request.stop_sequences).toEqual(["STOP"]);
		const withTools = providerRequest("claude-sonnet-5", { ...userContext(), tools: TOOLS });
		expect(withTools.tools).toEqual([
			{
				name: "Read",
				description: "Read a file",
				input_schema: { type: "object", properties: { path: { type: "string" } } },
			},
		]);
	});

	test("maps the requested effort onto output_config", () => {
		expect(providerRequest("claude-sonnet-5", userContext(), { reasoning: effort("medium") }).output_config).toEqual({
			effort: "medium",
		});
		expect(providerRequest("claude-sonnet-5", userContext(), { reasoning: effort("max") }).output_config).toEqual({
			effort: "xhigh",
		});
		expect(providerRequest("claude-sonnet-5", userContext()).output_config).toBeUndefined();
	});

	test("converts tool results into user tool_result blocks", () => {
		const context: Context = {
			systemPrompt: [],
			messages: [
				{ role: "user", content: "run it", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a.txt" } }],
					api: "zed-completions",
					provider: "zed",
					model: "claude-sonnet-5",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "Read",
					content: [{ type: "text", text: "a.txt" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		const request = providerRequest("claude-sonnet-5", context, {});
		const messages = request.messages as Array<Record<string, unknown>>;
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [{ type: "tool_use", id: "call_1", name: "Read", input: { path: "a.txt" } }],
		});
		expect(messages[2]).toEqual({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "call_1", content: "a.txt", is_error: false }],
		});
	});

	test("drops thinking blocks, which the upstream cannot accept unsigned", () => {
		const context: Context = {
			systemPrompt: [],
			messages: [
				{ role: "user", content: "hi", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "internal" },
						{ type: "text", text: "hello" },
					],
					api: "zed-completions",
					provider: "zed",
					model: "claude-sonnet-5",
					usage: NO_USAGE,
					stopReason: "stop",
					timestamp: 2,
				},
			],
		};
		const messages = providerRequest("claude-sonnet-5", context, {}).messages as Array<Record<string, unknown>>;
		expect(messages[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
	});
});

describe("responses dialect", () => {
	test("types message content and always requests a detailed reasoning summary", () => {
		const request = providerRequest("gpt-5.6-sol", userContext("ping"), {});
		expect(request.model).toBe("gpt-5.6-sol");
		expect(request.stream).toBe(true);
		expect(request.instructions).toBe("System prompt");
		expect(request.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }]);
		expect(request.reasoning).toEqual({ effort: "xhigh", summary: "detailed" });
		expect(request.max_output_tokens).toBe(32_768);
	});

	test("maps effort, including the disabled case, and floors small budgets", () => {
		expect(providerRequest("gpt-5.6-luna", userContext(), { reasoning: effort("low") }).reasoning).toEqual({
			effort: "low",
			summary: "detailed",
		});
		expect(providerRequest("gpt-5.6-luna", userContext(), { disableReasoning: true }).reasoning).toEqual({
			effort: "none",
			summary: "detailed",
		});
		expect(providerRequest("gpt-5.6-luna", userContext(), { reasoning: effort("minimal") }).reasoning).toEqual({
			effort: "low",
			summary: "detailed",
		});
		expect(providerRequest("gpt-5.6-luna", userContext(), { disableReasoning: true, maxTokens: 5 }).max_output_tokens).toBe(32);
		// A reasoning turn needs room for thinking, so its floor is much higher.
		expect(providerRequest("gpt-5.6-luna", userContext(), { maxTokens: 5 }).max_output_tokens).toBe(32_768);
		expect(providerRequest("gpt-5.5", userContext(), { reasoning: effort("low") }).reasoning).toEqual({
			effort: "xhigh",
			summary: "detailed",
		});
	});

	test("emits flat function tools and narrows a named tool choice to it", () => {
		const request = providerRequest("gpt-5.6-sol", { ...userContext(), tools: TOOLS }, {
			toolChoice: { type: "function", name: "Read" },
		});
		expect(request.tools).toEqual([
			{
				type: "function",
				name: "Read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		]);
		expect(request.tool_choice).toBe("required");
	});

	test("converts history into typed items, keeping arguments as JSON text", () => {
		const context: Context = {
			systemPrompt: [],
			messages: [
				{ role: "user", content: "run it", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "ok" },
						{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a.txt" } },
					],
					api: "zed-completions",
					provider: "zed",
					model: "gpt-5.6-sol",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "Read",
					content: [{ type: "text", text: "a.txt" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
		expect(providerRequest("gpt-5.6-sol", context, {}).input).toEqual([
			{ type: "message", role: "user", content: [{ type: "input_text", text: "run it" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			{ type: "function_call", call_id: "call_1", name: "Read", arguments: '{"path":"a.txt"}' },
			{ type: "function_call_output", call_id: "call_1", output: "a.txt" },
		]);
	});
});

describe("google dialect", () => {
	test("translates system, images, tool calls and merged tool results", () => {
		const context: Context = {
			systemPrompt: ["System prompt", "Second block"],
			tools: TOOLS,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "describe" },
						{ type: "image", mimeType: "image/png", data: "AAAA" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a.txt" } }],
					api: "zed-completions",
					provider: "zed",
					model: "gemini-2.5-pro",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "Read",
					content: [{ type: "text", text: "a.txt" }],
					isError: false,
					timestamp: 3,
				},
				{
					role: "toolResult",
					toolCallId: "call_2",
					toolName: "Read",
					content: [{ type: "text", text: "b.txt" }],
					isError: false,
					timestamp: 4,
				},
			],
		};
		const request = providerRequest("gemini-2.5-pro", context, {
			toolChoice: { type: "function", function: { name: "Read" } },
		});
		expect(request.model).toBe("models/gemini-2.5-pro");
		expect(request.systemInstruction).toEqual({ parts: [{ text: "System prompt\n\nSecond block" }] });
		expect(request.contents).toEqual([
			{
				role: "user",
				parts: [{ text: "describe" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }],
			},
			{ role: "model", parts: [{ functionCall: { name: "Read", args: { path: "a.txt" } } }] },
			{
				role: "user",
				parts: [
					{ functionResponse: { name: "Read", response: { result: "a.txt" } } },
					{ functionResponse: { name: "Read", response: { result: "b.txt" } } },
				],
			},
		]);
		expect(request.tools).toEqual([
			{
				functionDeclarations: [
					{
						name: "Read",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				],
			},
		]);
		expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Read"] } });
	});

	test("always sends candidateCount and stopSequences, and the budget only when asked", () => {
		const bare = providerRequest("gemini-2.5-pro", userContext()).generationConfig as Record<string, unknown>;
		expect(bare).toEqual({ candidateCount: 1, stopSequences: [] });
		expect(bare.maxOutputTokens).toBeUndefined();
		expect(bare.temperature).toBeUndefined();

		const budgeted = providerRequest("gemini-2.5-pro", userContext(), {
			maxTokens: 4_096,
			temperature: 0.2,
		}).generationConfig as Record<string, unknown>;
		expect(budgeted).toEqual({ candidateCount: 1, maxOutputTokens: 4_096, temperature: 0.2, stopSequences: [] });
	});
});

describe("xai dialect", () => {
	function conversation(): Context {
		return {
			systemPrompt: ["System prompt"],
			tools: TOOLS,
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image", mimeType: "image/png", data: "BBBB" },
					],
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "Read", arguments: { path: "a.txt" } }],
					api: "zed-completions",
					provider: "zed",
					model: "grok-4",
					usage: NO_USAGE,
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "Read",
					content: [{ type: "text", text: "a.txt" }],
					isError: false,
					timestamp: 3,
				},
			],
		};
	}

	test("emits chat-completions messages, a data URL image and tool calls", () => {
		const request = providerRequest("grok-4", conversation(), { toolChoice: "required" });
		expect(request.model).toBe("grok-4");
		expect(request.stream).toBe(true);
		expect(request.temperature).toBe(1);
		expect(request.reasoning).toBeUndefined();
		expect(request.messages).toEqual([
			{ role: "system", content: "System prompt" },
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
				],
			},
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "a.txt" },
		]);
		expect(request.tools).toEqual([
			{
				type: "function",
				function: {
					name: "Read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			},
		]);
		expect(request.tool_choice).toBe("required");
	});

	test("names a specific tool and forwards the requested temperature", () => {
		const request = providerRequest("grok-4", conversation(), {
			temperature: 0.4,
			maxTokens: 2_048,
			toolChoice: { type: "function", function: { name: "Read" } },
		});
		expect(request.temperature).toBe(0.4);
		expect(request.max_tokens).toBe(2_048);
		expect(request.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
	});
});

describe("dispatch and family limits", () => {
	test("routes gemini and grok ids to their own dialects", () => {
		const gemini = buildZedRequestBody("gemini-2.5-flash", userContext());
		expect(gemini.provider).toBe("google");
		expect(gemini.provider_request.model).toBe("models/gemini-2.5-flash");
		expect(gemini.provider_request.contents).toBeDefined();

		const grok = buildZedRequestBody("grok-4", userContext());
		expect(grok.provider).toBe("x_ai");
		expect(grok.provider_request.messages).toBeDefined();
		expect(grok.provider_request.contents).toBeUndefined();
	});

	test("reports the highest twin ceilings per model", () => {
		expect(familyLimits("claude-sonnet-5")).toEqual({ contextWindow: 1_000_000, maxTokens: 128_000 });
		expect(familyLimits("gpt-5.6-sol")).toEqual({ contextWindow: 1_050_000, maxTokens: 128_000 });
		expect(familyLimits("gemini-2.5-pro")).toEqual({ contextWindow: 1_048_576, maxTokens: 65_536 });
		expect(familyLimits("grok-4")).toEqual({ contextWindow: 256_000, maxTokens: 64_000 });
	});
});
