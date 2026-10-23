/**
 * The cached live catalog is what PI lists without running a refresh, so the
 * cache must follow the account and never cross accounts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCachedCatalog, writeCachedCatalog } from "../src/zed/catalog.ts";

const savedStore = process.env.ZED_ACCOUNTS_FILE;

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "zed-catalog-"));
	process.env.ZED_ACCOUNTS_FILE = join(dir, "accounts.json");
});

afterEach(() => {
	if (savedStore === undefined) delete process.env.ZED_ACCOUNTS_FILE;
	else process.env.ZED_ACCOUNTS_FILE = savedStore;
});

describe("model catalog cache", () => {
	test("returns the ids written for the same account", () => {
		writeCachedCatalog("123456", ["gpt-6-luna", "gpt-5.6-luna"]);
		expect(readCachedCatalog("123456")).toEqual(["gpt-6-luna", "gpt-5.6-luna"]);
	});

	test("does not serve another account's catalog", () => {
		writeCachedCatalog("123456", ["gpt-6-luna"]);
		expect(readCachedCatalog("999999")).toBeNull();
	});

	test("an absent cache or an empty id list is a miss", () => {
		expect(readCachedCatalog("123456")).toBeNull();
		writeCachedCatalog("123456", []);
		expect(readCachedCatalog("123456")).toBeNull();
	});
});
