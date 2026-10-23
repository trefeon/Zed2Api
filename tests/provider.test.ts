/**
 * End-to-end provider behaviour: host events produced from a stubbed Zed
 * stream, account rotation, and failure reporting.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";

import { createZedProvider, streamZedTurn, zedModelConfig } from "../src/provider.ts";
import { readUsage } from "../src/usage.ts";
import { readCachedCatalog } from "../src/zed/catalog.ts";
import {
	ANTHROPIC_STREAM,
	FAILURE_LINE,
	RESPONSES_TEXT_STREAM,
	RESPONSES_TOOL_STREAM,
	TEST_MODEL,
	seededStore,
	stubTransport,
	testContext,
} from "./fixtures.ts";

function tempStorePath(): string {
	return join(mkdtempSync(join(tmpdir(), "zed2api-provider-")), "accounts.json");
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Run `body` with the given env vars set, restoring the previous values after. */
function withEnv(vars: Record<string, string>, body: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const [name, value] of Object.entries(vars)) {
		saved[name] = process.env[name];
		process.env[name] = value;
	}
	try {
		body();
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("streamZedTurn", () => {
	test("emits host events for text, thinking, usage and completion", async () => {
		const store = seededStore(tempStorePath());
		const stub = stubTransport({ bodies: [RESPONSES_TEXT_STREAM] });
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "hi", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"done",
		]);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.reason).toBe("stop");
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.usage.input).toBe(11);
		expect(done.message.usage.output).toBe(7);
		expect(done.message.usage.totalTokens).toBe(18);
		expect(done.message.model).toBe("gpt-5.6-sol");
		expect(done.message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "thinking", thinking: "thinking hard", summary: true },
		]);
		expect(await stream.result()).toBe(done.message);

		const ledger = readUsage(store.path);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]).toMatchObject({ account: "main", model: "gpt-5.6-sol", input: 11, output: 7 });
		expect(ledger[0]?.costUsd).toBeCloseTo((11 * 4.4 + 7 * 22) / 1_000_000, 12);
	});

	test("assembles streamed tool arguments into one tool call", async () => {
		const store = seededStore(tempStorePath());
		const stub = stubTransport({ bodies: [RESPONSES_TOOL_STREAM] });
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "read", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		const toolEnd = events.find((event) => event.type === "toolcall_end");
		if (toolEnd?.type !== "toolcall_end") throw new Error("expected a toolcall_end event");
		expect(toolEnd.toolCall.name).toBe("Read");
		expect(toolEnd.toolCall.id).toBe("call_1");
		expect(toolEnd.toolCall.arguments).toEqual({ file_path: "a.txt" });
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.reason).toBe("toolUse");
	});

	test("maps the Anthropic dialect, including a tool_use stop reason", async () => {
		const store = seededStore(tempStorePath());
		const stub = stubTransport({ bodies: [ANTHROPIC_STREAM] });
		const stream = streamZedTurn(
			{ ...TEST_MODEL, id: "claude-sonnet-5" },
			testContext([{ role: "user", content: "hi", timestamp: 1 }]),
			{},
			{ store, transport: stub.transport },
		);
		const events = await collect(stream);
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.usage).toMatchObject({ input: 3, output: 2, totalTokens: 5 });
		const thinking = events.find((event) => event.type === "thinking_delta");
		expect(thinking).toMatchObject({ delta: "weighing" });
	});

	test("rotates to the next account when the first is rejected before any output", async () => {
		const store = seededStore(tempStorePath(), ["first", "second"]);
		const stub = stubTransport({
			statuses: [401, 200],
			bodies: ["unauthorized: bad credential", RESPONSES_TEXT_STREAM],
		});
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "hi", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		expect(stub.counts.completions).toBe(2);
		expect(stub.sent[0]).toMatchObject({ model: "gpt-5.6-sol" });
		const done = events.at(-1);
		if (done?.type !== "done") throw new Error("expected a done event");
		expect(done.message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "thinking", thinking: "thinking hard", summary: true },
		]);
		expect(store.find("first")?.disabledUntil).toBeGreaterThan(0);
		expect(store.find("second")?.consecutiveFailures).toBe(0);
	});

	test("does not replay a request-level rejection on another account", async () => {
		const store = seededStore(tempStorePath(), ["first", "second"]);
		const stub = stubTransport({ statuses: [400, 200], bodies: ["`temperature` is deprecated", RESPONSES_TEXT_STREAM] });
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "hi", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		expect(stub.counts.completions).toBe(1);
		const last = events.at(-1);
		if (last?.type !== "error") throw new Error("expected an error event");
		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toContain("deprecated");
		expect(store.find("first")?.disabledUntil).toBe(0);
	});

	test("leaves the account healthy when the 403 names a plan restriction", async () => {
		const store = seededStore(tempStorePath(), ["first", "second"]);
		const stub = stubTransport({
			statuses: [403, 200],
			bodies: ["model not included in your plan", RESPONSES_TEXT_STREAM],
		});
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "hi", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		expect(stub.counts.completions).toBe(2);
		expect(events.at(-1)?.type).toBe("done");
		expect(store.find("first")?.disabledUntil).toBe(0);
		expect(store.find("first")?.consecutiveFailures).toBe(0);
	});

	test("benches the account when the upstream rate-limits inside a 200 body", async () => {
		const store = seededStore(tempStorePath());
		const stub = stubTransport({ bodies: [FAILURE_LINE] });
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "hi", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		const last = events.at(-1);
		if (last?.type !== "error") throw new Error("expected an error event");
		expect(last.error.stopReason).toBe("error");
		expect(store.find("main")?.disabledUntil).toBeGreaterThan(0);
		expect(store.find("main")?.lastStatus).toBe(429);
	});

	test("reports a missing account instead of hanging", async () => {
		const store = seededStore(tempStorePath());
		store.remove("main");
		const stub = stubTransport({ bodies: [RESPONSES_TEXT_STREAM] });
		const stream = streamZedTurn(TEST_MODEL, testContext([{ role: "user", content: "hi", timestamp: 1 }]), {}, {
			store,
			transport: stub.transport,
		});
		const events = await collect(stream);
		const last = events.at(-1);
		if (last?.type !== "error") throw new Error("expected an error event");
		expect(last.error.errorMessage).toContain("No Zed account is connected");
		expect(stub.counts.completions).toBe(0);
	});

	test("marks an aborted turn as aborted rather than failed", async () => {
		const store = seededStore(tempStorePath());
		const controller = new AbortController();
		const stub = {
			...stubTransport({ bodies: [RESPONSES_TEXT_STREAM] }).transport,
			async completions() {
				controller.abort();
				throw Object.assign(new Error("aborted"), { name: "AbortError" });
			},
		};
		const stream = streamZedTurn(
			TEST_MODEL,
			testContext([{ role: "user", content: "hi", timestamp: 1 }]),
			{ signal: controller.signal },
			{ store, transport: stub },
		);
		const events = await collect(stream);
		const last = events.at(-1);
		if (last?.type !== "error") throw new Error("expected an error event");
		expect(last.reason).toBe("aborted");
		expect(last.error.stopReason).toBe("aborted");
	});
});

describe("assistant message shape", () => {
	test("keeps cost fields numeric and populated", async () => {
		const store = seededStore(tempStorePath());
		const stub = stubTransport({ bodies: [RESPONSES_TEXT_STREAM] });
		const message: AssistantMessage = await streamZedTurn(
			TEST_MODEL,
			testContext([{ role: "user", content: "hi", timestamp: 1 }]),
			{},
			{ store, transport: stub.transport },
		).result();
		expect(message.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(message.timestamp).toBeGreaterThan(0);
		expect(message.duration).toBeGreaterThanOrEqual(0);
	});
});

describe("zedModelConfig", () => {
	test("advertises a Google model with its twin limits and no thinking control", () => {
		const config = zedModelConfig("gemini-2.5-pro");
		expect(config.contextWindow).toBe(1_048_576);
		expect(config.maxTokens).toBe(65_536);
		expect(config.reasoning).toBe(false);
		expect(config.thinking).toBeUndefined();
		expect(config.input).toEqual(["text", "image"]);
	});

	test("advertises an xAI model with its twin window and no thinking control", () => {
		const config = zedModelConfig("grok-4");
		expect(config.contextWindow).toBe(256_000);
		expect(config.maxTokens).toBe(64_000);
		expect(config.reasoning).toBe(false);
		expect(config.thinking).toBeUndefined();
		expect(config.input).toEqual(["text", "image"]);
	});

	test("uses the twin Anthropic window, output cap and effort selector", () => {
		const config = zedModelConfig("claude-sonnet-5");
		expect(config.contextWindow).toBe(1_000_000);
		expect(config.maxTokens).toBe(128_000);
		expect(config.reasoning).toBe(true);
		expect(config.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high", "xhigh"], defaultLevel: "xhigh" });
		expect(config.input).toEqual(["text", "image"]);
	});

	test("uses the twin OpenAI limits and default xhigh effort", () => {
		const config = zedModelConfig("gpt-5.6-sol");
		expect(config.contextWindow).toBe(1_050_000);
		expect(config.maxTokens).toBe(128_000);
		expect(config.reasoning).toBe(true);
		expect(config.thinking).toEqual({ mode: "effort", efforts: ["low", "medium", "high", "xhigh"], defaultLevel: "xhigh" });
	});

	test("uses per-model twin limits for Luna and older Claude", () => {
		const luna = zedModelConfig("gpt-5.6-luna");
		expect(luna.contextWindow).toBe(1_050_000);
		expect(luna.maxTokens).toBe(128_000);
		const gpt6 = zedModelConfig("gpt-6-luna");
		expect(gpt6.contextWindow).toBe(1_050_000);
		expect(gpt6.maxTokens).toBe(128_000);
		const haiku = zedModelConfig("claude-haiku-4-5");
		expect(haiku.contextWindow).toBe(200_000);
		expect(haiku.maxTokens).toBe(64_000);
	});

	test("lets the env window override every family", () => {
		withEnv({ ZED2API_CONTEXT_WINDOW: "64000" }, () => {
			expect(zedModelConfig("gemini-2.5-pro").contextWindow).toBe(64_000);
			expect(zedModelConfig("grok-4").contextWindow).toBe(64_000);
			expect(zedModelConfig("claude-sonnet-5").contextWindow).toBe(64_000);
			expect(zedModelConfig("gpt-5.6-sol").contextWindow).toBe(64_000);
		});
	});

	test("lets each family output override win, and only for its family", () => {
		withEnv({ ZED2API_CLAUDE_MAX_TOKENS: "16000", ZED2API_GPT_MAX_TOKENS: "8000" }, () => {
			expect(zedModelConfig("claude-sonnet-5").maxTokens).toBe(16_000);
			expect(zedModelConfig("gpt-5.6-sol").maxTokens).toBe(8_000);
			expect(zedModelConfig("gemini-2.5-pro").maxTokens).toBe(65_536);
			expect(zedModelConfig("grok-4").maxTokens).toBe(64_000);
		});
	});
});

describe("catalog discovery", () => {
	test("keeps Gemini and xAI ids from the live catalog with their twin limits", async () => {
		const stub = stubTransport({
			bodies: [],
			modelIds: ["gpt-5.6-sol", "claude-sonnet-5", "gemini-2.5-pro", "grok-4"],
		});
		const store = seededStore(tempStorePath());
		const provider = createZedProvider({ store, transport: stub.transport });
		if (!provider.refreshModels) throw new Error("provider has no refreshModels hook");
		const models = await provider.refreshModels();
		expect(models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "claude-sonnet-5", "gemini-2.5-pro", "grok-4"]);
		expect(readCachedCatalog("user-main", store.path)).toEqual([
			"gpt-5.6-sol",
			"claude-sonnet-5",
			"gemini-2.5-pro",
			"grok-4",
		]);
		const gemini = models.find((model) => model.id === "gemini-2.5-pro");
		expect(gemini).toMatchObject({ contextWindow: 1_048_576, maxTokens: 65_536, reasoning: false });
		expect(gemini?.thinking).toBeUndefined();
		const grok = models.find((model) => model.id === "grok-4");
		expect(grok).toMatchObject({ contextWindow: 256_000, maxTokens: 64_000, reasoning: false });
		expect(grok?.thinking).toBeUndefined();
		expect(models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
		expect(models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
	});
});
