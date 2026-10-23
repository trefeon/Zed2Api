/**
 * Host context normalization: OMP declares the system prompt and tools beside
 * the messages, PI carries them as transcript system entries with deltas.
 */

import { describe, expect, test } from "bun:test";
import type { Context, Tool } from "@oh-my-pi/pi-ai";

import { normalizeHostContext } from "../src/host/context.ts";

const TOOL: Tool = {
	name: "Read",
	description: "Read a file",
	parameters: { type: "object", properties: { path: { type: "string" } } },
};

function piContext(): Context {
	// PI's transcript: the leading system entry holds prompt text, sections and
	// the tool declarations; later system entries patch them.
	return {
		messages: [
			{
				role: "system",
				content: "You are terse.",
				sections: { rules: "Never guess." },
				toolsAdded: [TOOL, { ...TOOL, name: "Bash", description: "Run a command" }],
				timestamp: 1,
			},
			{ role: "user", content: "hello", timestamp: 2 },
			{
				role: "system",
				content: "Extra context.",
				toolsRemoved: [{ ...TOOL, name: "Bash", description: "Run a command" }],
				timestamp: 3,
			},
		],
	} as unknown as Context;
}

describe("normalizeHostContext", () => {
	test("keeps the OMP shape: declared prompt and tools stay authoritative", () => {
		const normalized = normalizeHostContext({
			systemPrompt: ["Be terse."],
			tools: [TOOL],
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		});
		expect(normalized.system).toEqual(["Be terse."]);
		expect(normalized.tools).toEqual([TOOL]);
		expect(normalized.messages).toEqual([{ role: "user", content: "hi", timestamp: 1 }]);
	});

	test("replays a PI transcript: content, sections, tool deltas, no system messages", () => {
		const normalized = normalizeHostContext(piContext());
		expect(normalized.system).toEqual(["You are terse.", "Never guess.", "Extra context."]);
		expect(normalized.tools.map((tool) => tool.name)).toEqual(["Read"]);
		expect(normalized.messages).toEqual([{ role: "user", content: "hello", timestamp: 2 }]);
	});

	test("tolerates an empty context", () => {
		expect(normalizeHostContext(undefined)).toEqual({ system: [], messages: [], tools: [] });
	});
});
