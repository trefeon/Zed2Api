/**
 * Upstream wire decoding: the NDJSON dialects, control markers, and the
 * incremental line splitter.
 */

import { describe, expect, test } from "bun:test";

import { createLineSplitter, parseZedLine } from "../src/zed/wire.ts";
import { ANTHROPIC_STREAM, ANTHROPIC_TOOL_STREAM, FAILURE_LINE, RESPONSES_TEXT_STREAM } from "./fixtures.ts";

function deltasOf(stream: string) {
	return stream.split("\n").flatMap((line) => parseZedLine(line));
}

describe("parseZedLine", () => {
	test("decodes text and thinking deltas from the Responses dialect", () => {
		expect(deltasOf(RESPONSES_TEXT_STREAM)).toEqual([
			{ kind: "text", text: "Hel" },
			{ kind: "text", text: "lo" },
			{ kind: "thinking", text: "thinking hard" },
			{ kind: "stop", reason: null, usage: { inputTokens: 11, outputTokens: 7 } },
			{ kind: "ended" },
		]);
	});

	test("decodes the Anthropic dialect with stop reason and usage", () => {
		expect(deltasOf(ANTHROPIC_STREAM)).toEqual([
			{ kind: "thinking", text: "weighing" },
			{ kind: "tool_end" },
			{ kind: "text", text: "hi" },
			{ kind: "tool_end" },
			{ kind: "stop", reason: "end_turn", usage: { inputTokens: 3, outputTokens: 2 } },
			{ kind: "ended" },
		]);
	});

	test("decodes tool argument fragments from both dialects", () => {
		expect(deltasOf(ANTHROPIC_TOOL_STREAM)).toEqual([
			{ kind: "tool_start", id: "toolu_1", name: "Bash" },
			{ kind: "tool_args", json: '{"command"' },
			{ kind: "tool_args", json: ':"ls"}' },
			{ kind: "tool_end" },
			{ kind: "stop", reason: "tool_use", usage: null },
			{ kind: "ended" },
		]);
	});

	test("treats a 200-body failure as an error, with the embedded status", () => {
		expect(deltasOf(FAILURE_LINE)).toEqual([
			{ kind: "failure", status: 429, message: "rate limited" },
		]);
	});

	test("only the structural marker ends the stream", () => {
		// A delta that happens to contain the marker text is still model output.
		expect(parseZedLine(`{"event":{"type":"response.output_text.delta","delta":"stream_ended"}}`)).toEqual([
			{ kind: "text", text: "stream_ended" },
		]);
		expect(parseZedLine(`{"status":"in_progress"}`)).toEqual([]);
		expect(parseZedLine(`{"status":"stream_ended"}`)).toEqual([{ kind: "ended" }]);
	});

	test("ignores unparseable and non-JSON lines", () => {
		expect(parseZedLine("")).toEqual([]);
		expect(parseZedLine("   ")).toEqual([]);
		expect(parseZedLine("data: [DONE]")).toEqual([]);
		expect(parseZedLine("{not json")).toEqual([]);
		expect(parseZedLine('["array"]')).toEqual([]);
	});

	test("decodes xAI chat chunks and Google candidates as fallback dialects", () => {
		expect(parseZedLine(`{"choices":[{"delta":{"content":"hey","reasoning_content":"hmm"}}]}`)).toEqual([
			{ kind: "text", text: "hey" },
			{ kind: "thinking", text: "hmm" },
		]);
		expect(parseZedLine(`{"candidates":[{"content":{"parts":[{"text":"a"},{"text":"b"}]}}]}`)).toEqual([
			{ kind: "text", text: "ab" },
		]);
	});

	test("decodes Google text and function calls from one candidate", () => {
		expect(
			parseZedLine(
				`{"candidates":[{"content":{"parts":[{"text":"reading "},{"functionCall":{"name":"Read","args":{"path":"a"}}},{"text":"done"}]}}]}`,
			),
		).toEqual([
			{ kind: "text", text: "reading " },
			{ kind: "tool_start", id: "call_0", name: "Read" },
			{ kind: "tool_args", json: '{"path":"a"}' },
			{ kind: "text", text: "done" },
		]);
	});

	test("maps Google finish reasons and usage metadata", () => {
		expect(
			parseZedLine(
				`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"Read","args":{"path":"a"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":3}}`,
			),
		).toEqual([
			{ kind: "tool_start", id: "call_0", name: "Read" },
			{ kind: "tool_args", json: '{"path":"a"}' },
			{ kind: "stop", reason: "end_turn", usage: { inputTokens: 12, outputTokens: 3 } },
		]);
		expect(
			parseZedLine(
				`{"candidates":[{"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"cachedContentTokenCount":2}}`,
			),
		).toEqual([{ kind: "stop", reason: "length", usage: { inputTokens: 5, outputTokens: 1 } }]);
		expect(parseZedLine(`{"candidates":[{"content":{"parts":[]}}]}`)).toEqual([]);
	});

	test("normalizes cached input and Anthropic cache writes", () => {
		expect(
			parseZedLine(
				`{"event":{"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80},"output_tokens":10}}}}`,
			),
		).toEqual([
			{ kind: "stop", reason: null, usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 80 } },
		]);
		expect(
			parseZedLine(
				`{"event":{"type":"response.completed","response":{"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":80,"cache_write_tokens":10},"output_tokens":10}}}}`,
			),
		).toEqual([
			{ kind: "stop", reason: null, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 } },
		]);
		expect(
			parseZedLine(
				`{"event":{"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":1}}}}`,
			),
		).toEqual([
			{ kind: "usage", usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 30, cacheWriteTokens: 20 } },
		]);
		expect(
			parseZedLine(
				`{"event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}}`,
			),
		).toEqual([{ kind: "stop", reason: "end_turn", usage: { inputTokens: null, outputTokens: 2 } }]);
	});

	test("decodes xAI finish reasons and usage-only chunks", () => {
		expect(parseZedLine(`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`)).toEqual([
			{ kind: "stop", reason: "tool_use", usage: null },
		]);
		expect(parseZedLine(`{"choices":[{"delta":{"content":"bye"},"finish_reason":"stop"}]}`)).toEqual([
			{ kind: "text", text: "bye" },
			{ kind: "stop", reason: "end_turn", usage: null },
		]);
		expect(
			parseZedLine(
				`{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":4}}}`,
			),
		).toEqual([{ kind: "stop", reason: null, usage: { inputTokens: 8, outputTokens: 3, cacheReadTokens: 4 } }]);
		expect(parseZedLine(`{"usage":{"prompt_tokens":2,"completion_tokens":1}}`)).toEqual([
			{ kind: "stop", reason: null, usage: { inputTokens: 2, outputTokens: 1 } },
		]);
		// Every xAI chunk carries an explicit null finish_reason: it must stay text-only.
		expect(parseZedLine(`{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}`)).toEqual([
			{ kind: "text", text: "hi" },
		]);
	});
});

describe("createLineSplitter", () => {
	test("emits complete lines only and trims carriage returns", () => {
		const splitter = createLineSplitter();
		expect(splitter.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
		expect(splitter.push(':2}\n')).toEqual(['{"b":2}']);
		expect(splitter.flush()).toEqual([]);
	});

	test("flushes a trailing partial line once", () => {
		const splitter = createLineSplitter();
		expect(splitter.push('{"a":1}')).toEqual([]);
		expect(splitter.flush()).toEqual(['{"a":1}']);
		expect(splitter.flush()).toEqual([]);
	});
});
