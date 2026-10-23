/**
 * `x-zed-version` is resolved from a cached release lookup, and a minimum the
 * edge names must take effect without waiting for the next release of this
 * package. The resolver's disk cache lives beside the account store, so each
 * test gets its own store file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { currentClientVersion, FALLBACK_CLIENT_VERSION, noteMinimumVersion, resetClientVersionCache } from "../src/zed/clientVersion.ts";

const savedStore = process.env.ZED_ACCOUNTS_FILE;
const savedVersion = process.env.ZED2API_CLIENT_VERSION;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "zed-version-"));
	process.env.ZED_ACCOUNTS_FILE = join(dir, "accounts.json");
	delete process.env.ZED2API_CLIENT_VERSION;
	resetClientVersionCache();
});

afterEach(() => {
	if (savedStore === undefined) delete process.env.ZED_ACCOUNTS_FILE;
	else process.env.ZED_ACCOUNTS_FILE = savedStore;
	if (savedVersion === undefined) delete process.env.ZED2API_CLIENT_VERSION;
	else process.env.ZED2API_CLIENT_VERSION = savedVersion;
	resetClientVersionCache();
});

describe("client version resolution", () => {
	test("falls back to the verified release before any cache exists", () => {
		expect(currentClientVersion()).toBe(FALLBACK_CLIENT_VERSION);
	});

	test("an explicit override wins over the cache", () => {
		process.env.ZED2API_CLIENT_VERSION = "9.9.9";
		expect(currentClientVersion()).toBe("9.9.9");
	});

	test("adopts a minimum named by the edge and keeps it on disk", () => {
		noteMinimumVersion("99.0.0");
		expect(currentClientVersion()).toBe("99.0.0");

		resetClientVersionCache();
		expect(currentClientVersion()).toBe("99.0.0");
	});

	test("ignores a malformed minimum", () => {
		noteMinimumVersion(null);
		noteMinimumVersion("latest");
		noteMinimumVersion("1.2");
		expect(currentClientVersion()).toBe(FALLBACK_CLIENT_VERSION);
	});
});
