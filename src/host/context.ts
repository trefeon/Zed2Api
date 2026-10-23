/**
 * Host context normalization.
 *
 * OMP hands a context with `systemPrompt: string[]` and `tools: Tool[]` beside
 * plain chat messages. PI hands a transcript in which the system prompt and tool
 * declarations ride on `role: "system"` entries as `content`, `sections`,
 * `toolsAdded` and `toolsRemoved` deltas (`getCurrentSystemMessage` /
 * `getCurrentTools` in PI's `utils/transcript.ts`). OMP is a fork of PI and
 * accepts the same transcript shape, so both forms are folded here into the
 * single leading system prompt the Zed upstream expects.
 *
 * Folding every system entry into the leading prompt matches PI's
 * `collapseSystemMessages`: Zed's request body carries one top-level system
 * field, so mid-conversation placement is not expressible.
 */

import type { Context, Tool } from "@oh-my-pi/pi-ai";

import { asRecord } from "../json.ts";

export interface HostContext {
	/** System prompt blocks, in order. */
	system: string[];
	/** Chat messages, with every system entry removed. */
	messages: Context["messages"];
	/** Current tool declarations after applying transcript deltas. */
	tools: Tool[];
}

type UnknownRecord = Record<string, unknown>;

/** Text of a message content field: a string, or the text blocks of a parts array. */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			const record = asRecord(block);
			return record && record["type"] === "text" && typeof record["text"] === "string" ? record["text"] : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

/** PI renders a system message as its content followed by its named sections. */
function systemMessageText(message: UnknownRecord): string[] {
	const parts: string[] = [];
	const text = contentText(message["content"]);
	if (text.length > 0) parts.push(text);
	const sections = asRecord(message["sections"]);
	if (sections) {
		for (const value of Object.values(sections)) {
			if (typeof value === "string" && value.length > 0) parts.push(value);
		}
	}
	return parts;
}

/** Replay `toolsRemoved` / `toolsAdded` deltas from every system entry. */
function replayTools(messages: readonly UnknownRecord[]): Tool[] {
	const tools = new Map<string, Tool>();
	for (const message of messages) {
		if (message["role"] !== "system") continue;
		const removed = message["toolsRemoved"];
		if (Array.isArray(removed)) {
			for (const tool of removed) {
				const record = asRecord(tool);
				if (record && typeof record["name"] === "string") tools.delete(record["name"]);
			}
		}
		const added = message["toolsAdded"];
		if (Array.isArray(added)) {
			for (const tool of added) {
				const record = asRecord(tool);
				if (record && typeof record["name"] === "string") tools.set(record["name"], tool as Tool);
			}
		}
	}
	return [...tools.values()];
}

export function normalizeHostContext(context: Context | undefined): HostContext {
	const rawMessages: unknown[] = Array.isArray(context?.messages) ? context.messages : [];
	const records = rawMessages.map(asRecord).filter((entry): entry is UnknownRecord => entry !== null);

	const system: string[] = [];
	// Hosts differ: OMP declares `systemPrompt: string[]`; a PI transcript only
	// carries the prompt in system messages, which are replayed below.
	const declared: unknown = context?.systemPrompt;
	if (Array.isArray(declared)) {
		for (const text of declared) if (typeof text === "string" && text.length > 0) system.push(text);
	} else if (typeof declared === "string" && declared.length > 0) {
		system.push(declared);
	}
	if (system.length === 0) {
		for (const message of records) {
			if (message["role"] !== "system") continue;
			system.push(...systemMessageText(message));
		}
	}

	const declaredTools: unknown = context?.tools;
	const tools = Array.isArray(declaredTools) ? (declaredTools as Tool[]) : replayTools(records);

	const messages = (context?.messages ?? []).filter((message) => (message as { role: string }).role !== "system");
	return { system, messages, tools };
}
