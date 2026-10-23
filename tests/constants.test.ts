/**
 * Zed capability headers and the upstream base URL: the cloud edge gates
 * features on the headers, so losing one silently drops model families (the
 * xAI/Gemini rows) or stream status. The base URL exists so the wire can be
 * exercised against a local mock instead of the real upstream.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
	COMPLETIONS_URL,
	LLM_TOKENS_URL,
	MODELS_URL,
	USER_INFO_URL,
	ZED_CLOUD,
	completionsHeaders,
	modelsHeaders,
	tokenHeaders,
	zedCloudBase,
} from "../src/zed/constants.ts";

const X_AI_FLAG = "x-zed-client-supports-x-ai";
const STREAM_ENDED_FLAG = "x-zed-client-supports-stream-ended-request-completion-status";
const REAL_BASE = "https://cloud.zed.dev";

const savedBase = process.env.ZED_API_BASE;
afterEach(() => {
	if (savedBase === undefined) delete process.env.ZED_API_BASE;
	else process.env.ZED_API_BASE = savedBase;
});

describe("zed capability headers", () => {
	test("the model list advertises only the x-ai capability", () => {
		const headers = modelsHeaders("jwt-token");

		expect(headers[X_AI_FLAG]).toBe("true");
		expect(headers["authorization"]).toBe("Bearer jwt-token");
		expect(headers["x-zed-version"]).toBeUndefined();
	});

	test("the completions request carries the released version and stream flags", () => {
		const headers = completionsHeaders("jwt-token", "1.25.2");

		expect(headers[STREAM_ENDED_FLAG]).toBe("true");
		expect(headers["x-zed-client-supports-status-messages"]).toBe("true");
		expect(headers["x-zed-version"]).toBe("1.25.2");
		expect(headers["content-type"]).toBe("application/json");
		// Current upstream sends neither, and fetch defaults would betray the host.
		expect(headers["user-agent"]).toBeUndefined();
		expect(headers["accept"]).toBeUndefined();
	});

	test("the token endpoint names the account and the install", () => {
		const headers = tokenHeaders("123456", "credential-blob", "test-system-id");

		expect(headers["authorization"]).toBe("123456 credential-blob");
		expect(headers["x-zed-system-id"]).toBe("test-system-id");
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["user-agent"]).toBeUndefined();
	});
});

describe("zed cloud base URL", () => {
	test("defaults to the real cloud host", () => {
		delete process.env.ZED_API_BASE;
		expect(zedCloudBase()).toBe(REAL_BASE);
	});

	test("an override moves every upstream URL, trailing slashes included", () => {
		process.env.ZED_API_BASE = "http://127.0.0.1:8787/";
		expect(zedCloudBase()).toBe("http://127.0.0.1:8787");
	});

	test("an empty or blank override is not an override", () => {
		for (const value of ["", "   "]) {
			process.env.ZED_API_BASE = value;
			expect(zedCloudBase()).toBe(REAL_BASE);
		}
	});

	// The URL constants resolve the base once, at import, so they are compared
	// against the resolver's current answer: identical whenever the environment
	// has not changed since the module loaded, which is the case in this suite.
	test("the exported URLs hang off the resolved base", () => {
		const base = zedCloudBase();
		expect(ZED_CLOUD).toBe(base);
		expect(COMPLETIONS_URL).toBe(`${base}/completions`);
		expect(MODELS_URL).toBe(`${base}/models`);
		expect(LLM_TOKENS_URL).toBe(`${base}/client/llm_tokens`);
		expect(USER_INFO_URL).toBe(`${base}/client/users/me`);
	});
});
