/**
 * Zed `/completions` stream decoding, ported from
 * the reference gateway.
 *
 * The upstream answers with HTTP 200 and a newline-delimited JSON body: one
 * JSON object per line, usually wrapped as `{"event": { "type": ... }}`. Both
 * the Anthropic dialect (Claude models) and the OpenAI Responses dialect (GPT
 * models) arrive this way; the two other families the reference gateway
 * supports (xAI as Chat Completions chunks, Google as candidates) are decoded
 * here as well so any model the plan exposes works through one pipeline.
 *
 * Control lines are not model output: `{"status":"stream_ended"}` means the
 * answer is complete, and an HTTP-200 body carrying `{"status":{"failed":…}}`
 * is a rejection that must surface as an error instead of an empty turn.
 */

import { asRecord, readArray, readRecord, readString, type JsonRecord } from "../json.ts";

export interface ZedUsage {
	/** Uncached prompt tokens. OpenAI/xAI totals are reduced by cache tokens; Anthropic excludes them already. */
	inputTokens: number | null;
	outputTokens: number | null;
	/** Prompt tokens served from cache, billed at the cache-read rate. */
	cacheReadTokens?: number;
	/** Prompt tokens written to cache, billed at the cache-write rate (Anthropic). */
	cacheWriteTokens?: number;
}

export type ZedDelta =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tool_start"; id: string | null; name: string }
	| { kind: "tool_args"; json: string }
	| { kind: "tool_end" }
	| { kind: "usage"; usage: ZedUsage }
	| { kind: "stop"; reason: string | null; usage: ZedUsage | null }
	| { kind: "failure"; status: number; message: string }
	| { kind: "ended" };

function readUsage(record: JsonRecord): ZedUsage | null {
	const usage = readRecord(record, "usage");
	if (!usage) return null;
	const rawInput = readNumberLike(usage, ["input_tokens", "prompt_tokens"]);
	const output = readNumberLike(usage, ["output_tokens", "completion_tokens"]);
	// Anthropic reports cache reads/writes beside an input total that already
	// excludes them. OpenAI and xAI report a cached subset inside the prompt
	// total, so the uncached input is the difference.
	const details = readRecord(usage, "input_tokens_details") ?? readRecord(usage, "prompt_tokens_details");
	const cached =
		readNumberLike(usage, ["cache_read_input_tokens", "cached_tokens"]) ??
		(details ? readNumberLike(details, ["cached_tokens"]) : null);
	const cacheWrite =
		readNumberLike(usage, ["cache_creation_input_tokens", "cache_write_tokens"]) ??
		(details ? readNumberLike(details, ["cache_write_tokens"]) : null);
	const anthropic = "cache_creation_input_tokens" in usage || "cache_read_input_tokens" in usage;
	const input =
		rawInput === null ? null : anthropic ? rawInput : Math.max(0, rawInput - (cached ?? 0) - (cacheWrite ?? 0));
	const parsed: ZedUsage = { inputTokens: input, outputTokens: output };
	if (cached !== null) parsed.cacheReadTokens = cached;
	if (cacheWrite !== null) parsed.cacheWriteTokens = cacheWrite;
	return parsed;
}

/** Gemini reports usage under `usageMetadata` with its own counter names. */
function readGoogleUsage(record: JsonRecord): ZedUsage | null {
	const usage = readRecord(record, "usageMetadata");
	if (!usage) return null;
	// Gemini's promptTokenCount already includes cached content, and Zed bills
	// Gemini with no separate cached-input price; keep the whole prompt as input.
	return {
		inputTokens: readNumberLike(usage, ["promptTokenCount"]),
		outputTokens: readNumberLike(usage, ["candidatesTokenCount"]),
	};
}

/**
 * Chat Completions and Gemini name stop reasons their own way; normalize them to
 * the Anthropic spellings the provider's own reason mapping already understands.
 */
function mapStopReason(reason: string): string | null {
	switch (reason) {
		case "tool_use":
		case "tool_calls":
			return "tool_use";
		case "length":
		case "max_tokens":
		case "MAX_TOKENS":
			return "length";
		case "":
			return null;
		default:
			return "end_turn";
	}
}

function readNumberLike(record: JsonRecord, keys: string[]): number | null {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return null;
}

function readUpstreamFailure(root: JsonRecord): { status: number; message: string } | null {
	const status = readRecord(root, "status");
	if (!status) return null;
	const failed = readRecord(status, "failed");
	if (!failed) return null;
	const code = failed["status"] ?? failed["code"];
	const message = failed["message"] ?? failed["error"] ?? failed["reason"];
	// Codes arrive as `upstream_http_404`; unknown codes mean the upstream
	// reported a failure it could not classify, which surfaces as 502.
	const numeric = typeof code === "number" ? code : Number.parseInt(String(code ?? "").replace(/^upstream_http_/, ""), 10);
	return {
		status: Number.isFinite(numeric) ? numeric : 502,
		message: typeof message === "string" ? message : JSON.stringify(failed).slice(0, 500),
	};
}

/** Decode one upstream line into zero or more normalized deltas. */
export function parseZedLine(line: string): ZedDelta[] {
	const trimmed = line.trim();
	// Upstream is newline-delimited JSON, but a Google endpoint may answer as SSE;
	// the `data:` frame prefix then carries the payload.
	const payload = trimmed.startsWith("data:") ? trimmed.slice("data:".length).trim() : trimmed;
	if (payload.length === 0 || payload[0] !== "{") return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return [];
	}
	const root = asRecord(parsed);
	if (!root) return [];

	if (root["status"] === "stream_ended") return [{ kind: "ended" }];
	const failure = readUpstreamFailure(root);
	if (failure) return [{ kind: "failure", status: failure.status, message: failure.message }];

	const event = readRecord(root, "event") ?? root;
	const type = readString(event, "type");
	if (type === null) return parseFallbackDialect(event);
	return parseTypedEvent(type, event);
}

function parseTypedEvent(type: string, event: JsonRecord): ZedDelta[] {
	// ── OpenAI Responses dialect (GPT models) ──
	if (type === "response.output_text.delta") {
		const delta = readString(event, "delta");
		return delta ? [{ kind: "text", text: delta }] : [];
	}
	if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
		const delta = readString(event, "delta");
		return delta ? [{ kind: "thinking", text: delta }] : [];
	}
	if (type === "response.output_item.added") {
		const item = readRecord(event, "item");
		if (!item || readString(item, "type") !== "function_call") return [];
		return [
			{
				kind: "tool_start",
				id: readString(item, "call_id") ?? readString(item, "id"),
				name: readString(item, "name") ?? "",
			},
		];
	}
	if (type === "response.function_call_arguments.delta") {
		const delta = readString(event, "delta");
		return delta ? [{ kind: "tool_args", json: delta }] : [];
	}
	if (type === "response.function_call_arguments.done" || type === "response.output_item.done") {
		return [{ kind: "tool_end" }];
	}
	if (type === "response.completed") {
		const response = readRecord(event, "response") ?? event;
		return [{ kind: "stop", reason: readString(response, "stop_reason"), usage: readUsage(response) }];
	}
	if (type === "response.failed" || type === "response.error") {
		const response = readRecord(event, "response") ?? event;
		const error = readRecord(response, "error");
		const message = error ? (readString(error, "message") ?? JSON.stringify(error)) : "upstream reported a failed response";
		return [{ kind: "failure", status: 502, message }];
	}

	// ── Anthropic dialect (Claude models) ──
	if (type === "message_start") {
		const message = readRecord(event, "message");
		const usage = message ? readUsage(message) : null;
		return usage ? [{ kind: "usage", usage }] : [];
	}
	if (type === "content_block_start") {
		const block = readRecord(event, "content_block");
		if (!block) return [];
		const blockType = readString(block, "type");
		if (blockType === "tool_use") {
			return [{ kind: "tool_start", id: readString(block, "id"), name: readString(block, "name") ?? "" }];
		}
		if (blockType === "text") {
			const text = readString(block, "text");
			return text ? [{ kind: "text", text }] : [];
		}
		if (blockType === "thinking") {
			const thinking = readString(block, "thinking");
			return thinking ? [{ kind: "thinking", text: thinking }] : [];
		}
		return [];
	}
	if (type === "content_block_delta") {
		const delta = readRecord(event, "delta");
		if (!delta) return [];
		const deltaType = readString(delta, "type");
		if (deltaType === "text_delta") {
			const text = readString(delta, "text");
			return text ? [{ kind: "text", text }] : [];
		}
		if (deltaType === "thinking_delta") {
			const thinking = readString(delta, "thinking");
			return thinking ? [{ kind: "thinking", text: thinking }] : [];
		}
		if (deltaType === "input_json_delta") {
			const partial = readString(delta, "partial_json");
			return partial ? [{ kind: "tool_args", json: partial }] : [];
		}
		return [];
	}
	if (type === "content_block_stop") return [{ kind: "tool_end" }];
	if (type === "message_delta") {
		const delta = readRecord(event, "delta");
		return [{ kind: "stop", reason: delta ? readString(delta, "stop_reason") : null, usage: readUsage(event) }];
	}
	if (type === "message_stop") return [];

	return [];
}

/** xAI ships Chat Completions chunks and Google ships `candidates`. */
function parseFallbackDialect(event: JsonRecord): ZedDelta[] {
	const choices = readArray(event, "choices");
	if (choices) {
		const deltas: ZedDelta[] = [];
		const choice = choices.length > 0 ? asRecord(choices[0]) : null;
		const delta = choice ? readRecord(choice, "delta") : null;
		if (delta) {
			const content = readString(delta, "content");
			if (content) deltas.push({ kind: "text", text: content });
			const reasoning = readString(delta, "reasoning_content") ?? readString(delta, "reasoning");
			if (reasoning) deltas.push({ kind: "thinking", text: reasoning });
			for (const entry of readArray(delta, "tool_calls") ?? []) {
				const call = asRecord(entry);
				if (!call) continue;
				const fn = readRecord(call, "function");
				if (call["id"] !== undefined || call["type"] !== undefined) {
					deltas.push({ kind: "tool_start", id: readString(call, "id"), name: fn ? (readString(fn, "name") ?? "") : "" });
				}
				const args = fn ? readString(fn, "arguments") : null;
				if (args) deltas.push({ kind: "tool_args", json: args });
			}
		}
		// Every xAI chunk carries `finish_reason: null`; only a real reason, or the
		// trailing usage-only chunk, closes the turn.
		const finish = choice ? readString(choice, "finish_reason") : null;
		const usage = readUsage(event);
		if (finish !== null || usage) deltas.push({ kind: "stop", reason: finish === null ? null : mapStopReason(finish), usage });
		return deltas;
	}

	const candidates = readArray(event, "candidates");
	if (candidates) {
		const candidate = candidates.length > 0 ? asRecord(candidates[0]) : null;
		const content = candidate ? readRecord(candidate, "content") : null;
		const parts = content ? readArray(content, "parts") : null;
		const finish = candidate ? readString(candidate, "finishReason") : null;
		const usage = readGoogleUsage(event);
		const deltas: ZedDelta[] = [];
		let textRun = "";
		let callId = 0;
		// Gemini interleaves text and functionCall parts in one candidate; adjacent
		// text is joined so ordinary streaming still yields one delta per chunk.
		for (const entry of parts ?? []) {
			const part = asRecord(entry);
			if (!part) continue;
			const call = readRecord(part, "functionCall");
			if (call) {
				if (textRun.length > 0) {
					deltas.push({ kind: "text", text: textRun });
					textRun = "";
				}
				deltas.push({ kind: "tool_start", id: `call_${callId++}`, name: readString(call, "name") ?? "" });
				deltas.push({ kind: "tool_args", json: JSON.stringify(call["args"] ?? {}) ?? "{}" });
				continue;
			}
			const text = readString(part, "text");
			if (text) textRun += text;
		}
		if (textRun.length > 0) deltas.push({ kind: "text", text: textRun });
		if (finish !== null || usage) deltas.push({ kind: "stop", reason: finish === null ? null : mapStopReason(finish), usage });
		return deltas;
	}

	// Some gateways send the usage-only chunk without a `choices` array at all.
	const trailingUsage = readUsage(event);
	return trailingUsage ? [{ kind: "stop", reason: null, usage: trailingUsage }] : [];
}

/**
 * Incremental line decoder: feed raw body chunks, receive complete lines.
 * A trailing partial line stays buffered (carriage returns are trimmed).
 */
export interface LineSplitter {
	push(chunk: string): string[];
	/** Whatever is still buffered after the body ends. */
	flush(): string[];
}

export function createLineSplitter(): LineSplitter {
	let buffer = "";
	return {
		push(chunk: string): string[] {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
		},
		flush(): string[] {
			const remainder = buffer;
			buffer = "";
			return remainder.length > 0 ? [remainder] : [];
		},
	};
}
