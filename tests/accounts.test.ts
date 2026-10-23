/**
 * Account storage, rotation, cooldowns, and token caching.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AccountStore, STORE_DIR_MODE, STORE_FILE_MODE } from "../src/accounts.ts";

function tempStore(): { store: AccountStore; filePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "zed2api-accounts-"));
	const filePath = join(dir, "accounts.json");
	return { store: new AccountStore(filePath), filePath };
}

describe("account store", () => {
	test("round-trips the gateway's on-disk format, including a raw JSON credential", () => {
		const { store, filePath } = tempStore();
		store.load();
		store.add("main", "123456", '{"access_token":"zed_token_here","github_user_login":"user"}');
		const raw = JSON.parse(readFileSync(filePath, "utf8"));
		expect(raw).toEqual({
			main: {
				user_id: "123456",
				credential: { access_token: "zed_token_here", github_user_login: "user" },
			},
		});

		const reopened = new AccountStore(filePath);
		reopened.load();
		expect(reopened.find("main")?.credential).toBe('{"access_token":"zed_token_here","github_user_login":"user"}');
	});

	test("accepts a credential stored as a plain string and skips entries without a user id", () => {
		const { store, filePath } = tempStore();
		writeFileSync(
			filePath,
			JSON.stringify({
				plain: { user_id: "42", credential: "opaque-string" },
				broken: { credential: { access_token: "x" } },
			}),
		);
		store.load();
		expect(store.names()).toEqual(["plain"]);
		expect(store.find("plain")?.credential).toBe("opaque-string");
	});

	test("loads a store file that PowerShell wrote with a UTF-8 BOM", () => {
		const { store, filePath } = tempStore();
		writeFileSync(filePath, "\uFEFF" + JSON.stringify({ main: { user_id: "77", credential: { access_token: "t" } } }));

		store.load();

		expect(store.names()).toEqual(["main"]);
		expect(store.find("main")?.userId).toBe("77");
		expect(store.find("main")?.credential).toBe('{"access_token":"t"}');
	});

	test("remembers the active account next to the file", () => {
		const { store, filePath } = tempStore();
		store.add("first", "1", "{}");
		store.add("second", "2", "{}");
		store.switchTo("second");

		const reopened = new AccountStore(filePath);
		reopened.load();
		expect(reopened.current()?.name).toBe("second");
	});

	test("benches accounts by failure kind, with the gateway's thresholds", () => {
		const { store } = tempStore();
		const account = store.add("main", "1", "{}");
		const now = () => Math.floor(Date.now() / 1000);

		store.markFailure(account, "rate_limit", 429);
		expect(account.disabledUntil).toBeGreaterThanOrEqual(now() + 25);
		expect(store.available(account)).toBe(false);

		store.markSuccess(account, 200);
		expect(account.disabledUntil).toBe(0);
		expect(account.consecutiveFailures).toBe(0);
		expect(store.available(account)).toBe(true);

		// A single transient fault must not bench a healthy account.
		store.markFailure(account, "transient", 500);
		expect(account.disabledUntil).toBe(0);
		store.markFailure(account, "transient", 500);
		store.markFailure(account, "transient", 500);
		expect(account.disabledUntil).toBeGreaterThan(0);

		// Three auth failures in a row are a dead credential, not a blip.
		store.markSuccess(account, 200);
		store.markFailure(account, "auth", 401);
		expect(account.disabledUntil - now()).toBeLessThanOrEqual(305);
		store.markFailure(account, "auth", 401);
		store.markFailure(account, "auth", 401);
		expect(account.disabledUntil - now()).toBeGreaterThan(3_000);
	});

	test("orders attempts healthy-first and falls back to the soonest recovery", () => {
		const { store } = tempStore();
		const first = store.add("first", "1", "{}");
		const second = store.add("second", "2", "{}");
		const third = store.add("third", "3", "{}");
		store.switchTo("third");

		expect(store.tryOrder().map((account) => account.name)).toEqual(["third", "first", "second"]);

		store.markFailure(third, "auth", 401);
		store.markFailure(first, "rate_limit", 429);
		expect(store.tryOrder().map((account) => account.name)).toEqual(["second", "first", "third"]);

		// Even with everything benched the least-bad account still leads.
		store.markFailure(second, "auth", 401);
		expect(store.tryOrder()).toHaveLength(3);
		expect(store.tryOrder()[0]?.name).toBe("first");
	});

	test("refreshes the token once and reuses the cached one", async () => {
		const { store } = tempStore();
		const account = store.add("main", "1", "{}", "org_test");
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;
			return new Response(JSON.stringify({ token: jwt }), { status: 200 });
		}) as unknown as typeof fetch;

		const [a, b] = await Promise.all([store.tokenFor(account, fetchImpl), store.tokenFor(account, fetchImpl)]);
		expect(a).toBe(b);
		expect(calls).toBe(1);
		expect(await store.tokenFor(account, fetchImpl)).toBe(a);
		expect(calls).toBe(1);

		store.invalidateToken(account);
		await store.tokenFor(account, fetchImpl);
		expect(calls).toBe(2);
	});

	test("discovers the organization before minting a token", async () => {
		const { store } = tempStore();
		const account = store.add("main", "user_01newstyle", "credential-blob");
		const bodies: string[] = [];
		const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.sig`;
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/client/users/me")) {
				return new Response(
					JSON.stringify({ user: { id: 1234, legacy_user_id: 123456 }, organizations: [{ id: "org_test" }] }),
					{ status: 200 },
				);
			}
			if (url.endsWith("/client/llm_tokens")) {
				bodies.push(String(init?.body ?? ""));
				return new Response(JSON.stringify({ token: jwt }), { status: 200 });
			}
			return new Response("unexpected", { status: 500 });
		}) as typeof fetch;

		expect(await store.tokenFor(account, fetchImpl)).toBe(jwt);
		expect(account.organizationId).toBe("org_test");
		expect(account.userId).toBe("123456");
		expect(bodies).toHaveLength(1);
		expect(JSON.parse(bodies[0] ?? "{}").organization_id).toBe("org_test");
	});

	test("surfaces a failed token refresh as an HTTP error", async () => {
		const { store } = tempStore();
		const account = store.add("main", "1", "{}", "org_test");
		const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
		await expect(store.tokenFor(account, fetchImpl)).rejects.toThrow(/403/);
		expect(account.jwtToken).toBeNull();
	});
});

describe("account store hardening", () => {
	// The store's modes are POSIX bits, and Windows reports every writable file
	// as 0o666 regardless of what was requested, so assert on the arguments the
	// store hands to node:fs instead of on the file's real mode.
	const mkdirSpy = spyOn(nodeFs, "mkdirSync");
	const writeSpy = spyOn(nodeFs, "writeFileSync");
	const chmodSpy = spyOn(nodeFs, "chmodSync");

	beforeEach(() => {
		mkdirSpy.mockClear();
		writeSpy.mockClear();
		chmodSpy.mockClear();
	});

	afterAll(() => {
		mkdirSpy.mockRestore();
		writeSpy.mockRestore();
		chmodSpy.mockRestore();
	});

	test("save() asks for a 0700 directory and a 0600 file", () => {
		const dir = mkdtempSync(join(tmpdir(), "zed2api-modes-"));
		const storeDir = join(dir, "store");
		const filePath = join(storeDir, "accounts.json");
		new AccountStore(filePath).add("main", "1", "{}");

		expect(mkdirSpy.mock.calls.some((call) => String(call[0]) === storeDir && modeOf(call[1]) === STORE_DIR_MODE)).toBe(
			true,
		);
		expect(writeSpy.mock.calls.some((call) => String(call[0]) === filePath && modeOf(call[2]) === STORE_FILE_MODE)).toBe(
			true,
		);
		expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({ main: { user_id: "1", credential: {} } });
		rmSync(dir, { recursive: true, force: true });
	});

	test("path reports the configured store file", () => {
		const { store, filePath } = tempStore();
		expect(store.path).toBe(filePath);
	});

	test("save() narrows a store file that is already wider than 0600", () => {
		const { store, filePath } = tempStore();
		store.add("main", "1", "{}");
		chmodSync(filePath, 0o644);
		chmodSpy.mockClear();

		store.save();

		expect(chmodSpy.mock.calls.some((call) => String(call[0]) === filePath && call[1] === STORE_FILE_MODE)).toBe(true);
	});

	test("load() narrows an existing store file that is wider than 0600", () => {
		const { store, filePath } = tempStore();
		writeFileSync(filePath, JSON.stringify({ main: { user_id: "1", credential: "{}" } }));
		chmodSync(filePath, 0o644);
		chmodSpy.mockClear();

		store.load();

		expect(chmodSpy.mock.calls.some((call) => String(call[0]) === filePath && call[1] === STORE_FILE_MODE)).toBe(true);
		expect(store.names()).toEqual(["main"]);
	});

	test("load() rejects an unparsable store file and leaves it untouched", () => {
		const { store, filePath } = tempStore();
		writeFileSync(filePath, "{ not json");

		expect(() => store.load()).toThrow(/not valid JSON/);
		expect(store.length).toBe(0);
		expect(readFileSync(filePath, "utf8")).toBe("{ not json");
	});
});

/** `mode` from an fs options argument, which may be an options object or absent. */
function modeOf(options: unknown): unknown {
	if (typeof options !== "object" || options === null || !("mode" in options)) return undefined;
	return options.mode;
}
