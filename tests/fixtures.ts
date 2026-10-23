/**
 * Fixtures and stubs shared by the plugin tests.
 *
 * The NDJSON bodies are the shapes Zed actually streams: one JSON object per
 * line, usually wrapped in `{"event": …}`, terminated by
 * `{"status":"stream_ended"}` (matching the reference gateway's stream).
 */

import type { Context, Effort, Model, Usage } from "@oh-my-pi/pi-ai";

import { AccountStore } from "../src/accounts.ts";
import type { ZedTransport } from "../src/zed/client.ts";

export const RESPONSES_TEXT_STREAM = [
	`{"event":{"type":"response.output_text.delta","delta":"Hel"}}`,
	`{"event":{"type":"response.output_text.delta","delta":"lo"}}`,
	`{"event":{"type":"response.reasoning_summary_text.delta","delta":"thinking hard"}}`,
	`{"event":{"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":11,"output_tokens":7}}}}`,
	`{"status":"stream_ended"}`,
].join("\n");

export const RESPONSES_TOOL_STREAM = [
	`{"event":{"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"Read","arguments":""}}}`,
	`{"event":{"type":"response.function_call_arguments.delta","delta":"{\\"file"}}`,
	`{"event":{"type":"response.function_call_arguments.delta","delta":"_path\\":\\"a.txt\\"}"}}`,
	`{"event":{"type":"response.function_call_arguments.done"}}`,
	`{"event":{"type":"response.completed","response":{"usage":{"input_tokens":4,"output_tokens":9}}}}`,
	`{"status":"stream_ended"}`,
].join("\n");

export const ANTHROPIC_STREAM = [
	`{"event":{"type":"message_start","message":{"model":"claude-sonnet-5"}}}`,
	`{"event":{"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}}`,
	`{"event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"weighing"}}}`,
	`{"event":{"type":"content_block_stop"}}`,
	`{"event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}`,
	`{"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}}`,
	`{"event":{"type":"content_block_stop"}}`,
	`{"event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3,"output_tokens":2}}}`,
	`{"event":{"type":"message_stop"}}`,
	`{"status":"stream_ended"}`,
].join("\n");

export const ANTHROPIC_TOOL_STREAM = [
	`{"event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"Bash"}}}`,
	`{"event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"command\\""}}}`,
	`{"event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":":\\"ls\\"}"}}}`,
	`{"event":{"type":"content_block_stop"}}`,
	`{"event":{"type":"message_delta","delta":{"stop_reason":"tool_use"}}}`,
	`{"status":"stream_ended"}`,
].join("\n");

export const FAILURE_LINE = `{"status":{"failed":{"code":"upstream_http_429","message":"rate limited","retry_after":30}}}`;

/** A response whose body streams the given NDJSON text in arbitrary chunks. */
export function ndjsonResponse(text: string, chunkSize = 17): Response {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(text);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (let offset = 0; offset < bytes.length; offset += chunkSize) {
				controller.enqueue(bytes.slice(offset, offset + chunkSize));
			}
			controller.close();
		},
	});
	return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

export interface StubTransport {
	transport: ZedTransport;
	/** Payloads the provider sent, in order. */
	sent: unknown[];
	counts: { models: number; completions: number };
}

export interface StubTransportOptions {
	/** One response body per completion attempt, in order. */
	bodies: string[];
	/** Status per attempt; a non-200 attempt throws before streaming. */
	statuses?: number[];
	modelIds?: string[];
}

export function stubTransport(options: StubTransportOptions): StubTransport {
	const sent: unknown[] = [];
	const counts = { models: 0, completions: 0 };
	let attempt = 0;
	const transport: ZedTransport = {
		async completions(_jwt, body) {
			sent.push(body);
			counts.completions += 1;
			const status = options.statuses?.[attempt] ?? 200;
			const text = options.bodies[attempt] ?? "";
			attempt += 1;
			if (status !== 200) return new Response(text, { status });
			return ndjsonResponse(text);
		},
		async models() {
			counts.models += 1;
			return { models: (options.modelIds ?? ["gpt-5.6-sol", "claude-sonnet-5"]).map((id) => ({ id })) };
		},
		async userInfo() {
			return {};
		},
	};
	return { transport, sent, counts };
}

export const TEST_MODEL: Model = {
	id: "gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "zed-completions",
	provider: "zed",
	baseUrl: "https://cloud.zed.dev",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_768,
	identity: { class: "unknown" },
	compat: undefined,
};

/** All-zero usage for history messages; cost is required by the host's type. */
export const NO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** `Effort` is a const enum, so a literal level needs an assertion at the call site. */
export function effort(value: "minimal" | "low" | "medium" | "high" | "xhigh" | "max"): Effort {
	return value as Effort;
}

export function testContext(messages: Context["messages"] = []): Context {
	return { systemPrompt: ["Be terse."], messages };
}

/** A store whose single account already holds a cached token, so no network is used. */
export function seededStore(filePath: string, names: string[] = ["main"]): AccountStore {
	const store = new AccountStore(filePath);
	for (const name of names) store.add(name, `user-${name}`, `{"access_token":"token-${name}"}`);
	const now = Math.floor(Date.now() / 1000);
	for (const name of names) {
		const account = store.find(name);
		if (!account) continue;
		account.jwtToken = `${name}.jwt.token`;
		account.jwtExpiresAt = now + 3600;
	}
	return store;
}
