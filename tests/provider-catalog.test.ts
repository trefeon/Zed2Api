/**
 * Host-visible catalog behavior: the registered `models` list is what PI's
 * `--list-models` shows, and PI does not run a provider refresh there. The
 * provider must therefore seed from the cached live catalog and refresh that
 * cache whenever discovery succeeds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountStore } from "../src/accounts.ts";
import { createZedProvider } from "../src/provider.ts";
import type { ZedTransport } from "../src/zed/client.ts";
import { readCachedCatalog, writeCachedCatalog } from "../src/zed/catalog.ts";

const savedStore = process.env.ZED_ACCOUNTS_FILE;
let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-zed-provider-catalog-"));
	process.env.ZED_ACCOUNTS_FILE = join(dir, "accounts.json");
});

afterEach(() => {
	if (savedStore === undefined) delete process.env.ZED_ACCOUNTS_FILE;
	else process.env.ZED_ACCOUNTS_FILE = savedStore;
});

function stubTransport(models: unknown): ZedTransport {
	return {
		async completions() {
			throw new Error("not used");
		},
		async models() {
			return models;
		},
		async userInfo() {
			throw new Error("not used");
		},
	};
}

describe("provider catalog seeding", () => {
	test("registers the cached live ids, not only the built-in list", () => {
		const store = new AccountStore();
		store.load();
		store.add("main", "123456", "credential-blob");
		writeCachedCatalog("123456", ["gpt-6-luna", "claude-sonnet-5"]);

		const provider = createZedProvider({ store, transport: stubTransport({ models: [] }) });
		expect((provider.models ?? []).map((model) => model.id)).toContain("gpt-6-luna");
	});

	test("a successful refresh writes the cache for the account", async () => {
		const store = new AccountStore();
		store.load();
		store.add("main", "123456", "credential-blob");
		const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/client/users/me")) {
				return new Response(JSON.stringify({ user: { legacy_user_id: 123456 }, organizations: [{ id: "org_test" }] }), {
					status: 200,
				});
			}
			if (url.endsWith("/client/llm_tokens")) {
				return new Response(JSON.stringify({ token: jwt }), { status: 200 });
			}
			throw new Error(`unexpected ${url}`);
		}) as typeof fetch;
		const provider = createZedProvider({
			store,
			transport: stubTransport({ models: [{ id: "gpt-6-luna" }, { id: "gpt-5.6-luna" }] }),
			fetchImpl,
		});

		await provider.refreshModels?.();

		expect(readCachedCatalog("123456")).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
		expect((provider.models ?? []).map((model) => model.id)).not.toContain("gpt-6-luna");
	});
});
