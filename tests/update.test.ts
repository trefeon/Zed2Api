/**
 * Self-update: the extension asks the npm registry for a newer release and,
 * when the host installed it from the registry, upgrades it in place.
 *
 * Every test injects the registry, the child process, the clock, and the store
 * file, so nothing here touches the real registry, the real host CLI, or the
 * operator's home directory.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	checkForUpdate,
	compareVersions,
	detectInstall,
	formatUpdateResult,
	maybeAutoUpdate,
	pendingUpdate,
	readUpdateState,
	resetUpdateMemory,
	type CommandRunner,
} from "../src/update.ts";

let dir = "";
let store = "";
let root = "";
const NOW = 1_800_000_000_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-zed-update-"));
	store = join(dir, "state", "accounts.json");
	mkdirSync(join(dir, "state"), { recursive: true });
	root = join(dir, ".omp", "plugins", "node_modules", "pi-zed-provider");
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-zed-provider", version: "0.1.3" }));
	resetUpdateMemory();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	resetUpdateMemory();
});

/** A registry stub that answers with the given body and counts the calls. */
function registry(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: () => number } {
	let calls = 0;
	const fetchImpl = (async () => {
		calls += 1;
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls: () => calls };
}

/** A child-process stub that records the invocation and rewrites the version. */
function runner(writeVersion: string | null): { exec: CommandRunner; calls: () => string[][] } {
	const calls: string[][] = [];
	const exec: CommandRunner = async (command, args) => {
		calls.push([command, ...args]);
		if (writeVersion !== null) {
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-zed-provider", version: writeVersion }));
		}
		return { code: 0, output: "done" };
	};
	return { exec, calls: () => calls };
}

describe("compareVersions", () => {
	test("orders numeric segments, not strings", () => {
		expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
		expect(compareVersions("0.1.3", "0.1.3")).toBe(0);
		expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
		expect(compareVersions("0.1.3", "1.0.0")).toBeLessThan(0);
	});

	test("treats a short version as zero-padded", () => {
		expect(compareVersions("0.2", "0.1.9")).toBeGreaterThan(0);
	});
});

describe("detectInstall", () => {
	test("recognizes an OMP plugin directory", () => {
		expect(detectInstall(root)).toEqual({ kind: "omp", root, version: "0.1.3" });
	});

	test("recognizes a PI npm install", () => {
		const pi = join(dir, ".pi", "agent", "npm", "node_modules", "pi-zed-provider");
		mkdirSync(pi, { recursive: true });
		writeFileSync(join(pi, "package.json"), JSON.stringify({ name: "pi-zed-provider", version: "0.1.2" }));
		expect(detectInstall(pi)).toEqual({ kind: "pi", root: pi, version: "0.1.2" });
	});

	test("recognizes a source checkout before the host path heuristics", () => {
		mkdirSync(join(root, ".git"), { recursive: true });
		expect(detectInstall(root).kind).toBe("git");
	});

	test("an unrecognized location cannot be upgraded", () => {
		const loose = join(dir, "elsewhere");
		mkdirSync(loose, { recursive: true });
		writeFileSync(join(loose, "package.json"), JSON.stringify({ name: "pi-zed-provider", version: "0.1.3" }));
		expect(detectInstall(loose).kind).toBe("unknown");
	});
});

describe("checkForUpdate", () => {
	test("a cached answer inside the TTL is reused without a request", async () => {
		writeFileSync(
			join(dir, "state", "update-check.json"),
			JSON.stringify({ version: 1, checkedAt: NOW - 60_000, latest: "0.1.9", attemptedAt: 0, attemptedVersion: null, updatedAt: 0, lastError: null }),
		);
		const stub = registry({ version: "0.9.9" });
		const check = await checkForUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, now: () => NOW });
		expect(check.latest).toBe("0.1.9");
		expect(stub.calls()).toBe(0);
	});

	test("a stale cache is refreshed and persisted", async () => {
		const stub = registry({ version: "0.2.0" });
		const check = await checkForUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, now: () => NOW });
		expect(check.latest).toBe("0.2.0");
		expect(stub.calls()).toBe(1);
		expect(readUpdateState(store)?.latest).toBe("0.2.0");
		expect(readUpdateState(store)?.checkedAt).toBe(NOW);
	});

	test("--force bypasses the TTL", async () => {
		writeFileSync(
			join(dir, "state", "update-check.json"),
			JSON.stringify({ version: 1, checkedAt: NOW - 60_000, latest: "0.1.9", attemptedAt: 0, attemptedVersion: null, updatedAt: 0, lastError: null }),
		);
		const stub = registry({ version: "0.2.0" });
		const check = await checkForUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, now: () => NOW, force: true });
		expect(check.latest).toBe("0.2.0");
		expect(stub.calls()).toBe(1);
	});

	test("a registry failure keeps the last known version and records the reason", async () => {
		writeFileSync(
			join(dir, "state", "update-check.json"),
			JSON.stringify({ version: 1, checkedAt: 0, latest: "0.1.9", attemptedAt: 0, attemptedVersion: null, updatedAt: 0, lastError: null }),
		);
		const failing = (async () => {
			throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
		}) as unknown as typeof fetch;
		const check = await checkForUpdate({ root, storePath: store, fetchImpl: failing, now: () => NOW });
		expect(check.error).toContain("ENOTFOUND");
		expect(readUpdateState(store)?.latest).toBe("0.1.9");
	});

	test("a malformed registry body is not adopted as a version", async () => {
		const stub = registry({ version: "latest" });
		const check = await checkForUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, now: () => NOW });
		expect(check.latest).toBeNull();
		expect(check.error).toContain("no usable version");
	});
});

describe("maybeAutoUpdate", () => {
	test("upgrades an OMP install and reports the version that landed", async () => {
		const stub = registry({ version: "0.2.0" });
		const child = runner("0.2.0");
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });

		expect(result.status).toBe("updated");
		expect(result.latest).toBe("0.2.0");
		expect(child.calls()).toEqual([["omp", "plugin", "upgrade", "pi-zed-provider"]]);
		expect(readUpdateState(store)?.updatedAt).toBe(NOW);
		expect(formatUpdateResult(result)).toContain("0.1.3 → 0.2.0");
	});

	test("upgrades a PI install with pi's own update verb", async () => {
		const piRoot = join(dir, ".pi", "agent", "npm", "node_modules", "pi-zed-provider");
		mkdirSync(piRoot, { recursive: true });
		writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "pi-zed-provider", version: "0.1.3" }));
		root = piRoot;
		const stub = registry({ version: "0.2.0" });
		const child = runner("0.2.0");
		await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });
		expect(child.calls()).toEqual([["pi", "update", "npm:pi-zed-provider"]]);
	});

	test("a newer release that leaves the install behind is a failure, not a success", async () => {
		const stub = registry({ version: "0.2.0" });
		const child = runner(null);
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });
		expect(result.status).toBe("failed");
		expect(result.detail).toContain("still reports 0.1.3");
		expect(readUpdateState(store)?.lastError).toContain("still reports 0.1.3");
	});

	test("a failed upgrade is not retried on every session start", async () => {
		const stub = registry({ version: "0.2.0" });
		const child = runner(null);
		await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });
		const second = await maybeAutoUpdate({
			root,
			storePath: store,
			fetchImpl: stub.fetchImpl,
			exec: child.exec,
			now: () => NOW + 60_000,
		});
		expect(second.status).toBe("throttled");
		expect(child.calls()).toHaveLength(1);
	});

	test("a source checkout is reported, never pulled", async () => {
		mkdirSync(join(root, ".git"), { recursive: true });
		const stub = registry({ version: "0.2.0" });
		const child = runner("0.2.0");
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });
		expect(result.status).toBe("unmanaged");
		expect(child.calls()).toEqual([]);
		expect(formatUpdateResult(result)).toContain("git pull");
	});

	test("an already-current install never shells out", async () => {
		const stub = registry({ version: "0.1.3" });
		const child = runner("0.2.0");
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });
		expect(result.status).toBe("current");
		expect(child.calls()).toEqual([]);
	});

	test("an unreachable registry is silent, not an error the host shows", async () => {
		const failing = (async () => {
			throw new Error("fetch failed");
		}) as unknown as typeof fetch;
		const child = runner("0.2.0");
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: failing, exec: child.exec, now: () => NOW });
		expect(result.status).toBe("unavailable");
		expect(child.calls()).toEqual([]);
	});

	test("a lock held by another process wins", async () => {
		writeFileSync(join(dir, "state", "update.lock"), "");
		const stub = registry({ version: "0.2.0" });
		const child = runner("0.2.0");
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec: child.exec, now: () => NOW });
		expect(result.status).toBe("locked");
		expect(child.calls()).toEqual([]);
	});

	test("a non-zero exit records the command output as the reason", async () => {
		const stub = registry({ version: "0.2.0" });
		const exec: CommandRunner = async () => ({ code: 1, output: "bun install failed: ENOSPC" });
		const result = await maybeAutoUpdate({ root, storePath: store, fetchImpl: stub.fetchImpl, exec, now: () => NOW });
		expect(result.status).toBe("failed");
		expect(result.detail).toContain("ENOSPC");
		expect(readUpdateState(store)?.attemptedVersion).toBe("0.2.0");
	});
});

describe("pendingUpdate", () => {
	test("names a cached newer release without touching the network", () => {
		writeFileSync(
			join(dir, "state", "update-check.json"),
			JSON.stringify({ version: 1, checkedAt: NOW, latest: "0.2.0", attemptedAt: 0, attemptedVersion: null, updatedAt: 0, lastError: null }),
		);
		const line = pendingUpdate(store, "0.1.3");
		expect(line).toContain("0.2.0");
		expect(line).toContain("0.1.3");
	});

	test("stays quiet when the cached release is not newer", () => {
		writeFileSync(
			join(dir, "state", "update-check.json"),
			JSON.stringify({ version: 1, checkedAt: NOW, latest: "0.1.3", attemptedAt: 0, attemptedVersion: null, updatedAt: 0, lastError: null }),
		);
		expect(pendingUpdate(store, "0.1.3")).toBeNull();
	});

	test("stays quiet before any check has run", () => {
		expect(pendingUpdate(store, "0.1.3")).toBeNull();
	});
});
