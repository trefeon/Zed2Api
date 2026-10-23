/**
 * The last live model catalog, cached beside the account store.
 *
 * PI does not run provider refresh for `--list-models` (only the interactive
 * picker refreshes), so registering only the built-in ids would leave its
 * catalog stale until a refresh happens in the right UI. Caching the ids the
 * upstream returned and seeding the provider's initial `models` list from the
 * cache makes the live catalog visible to every host on the next process,
 * without a network call at registration.
 *
 * The cache is keyed by user id: a different account's entitlements must not
 * leak into this account's picker.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { STORE_DIR_MODE, STORE_FILE_MODE, storeDirectory } from "../accounts.ts";

interface CatalogCache {
	version: 1;
	userId: string;
	ids: string[];
	updatedAt: number;
}

/** The cache lives beside the account store that owns it, never the default home. */
function catalogPath(storePath?: string): string {
	const directory = storePath ? dirname(storePath) : storeDirectory();
	return join(directory, "model-catalog.json");
}

/** Cached ids for this account, or null when absent or from another account. */
export function readCachedCatalog(userId: string | undefined, storePath?: string): string[] | null {
	if (!userId) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(catalogPath(storePath), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Partial<CatalogCache>;
		if (record.version !== 1 || record.userId !== userId || !Array.isArray(record.ids)) return null;
		const ids = record.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
		return ids.length > 0 ? ids : null;
	} catch {
		return null;
	}
}

/** Persist the catalog after a successful live fetch. */
export function writeCachedCatalog(userId: string, ids: readonly string[], storePath?: string): void {
	if (!userId || ids.length === 0) return;
	try {
		const directory = storePath ? dirname(storePath) : storeDirectory();
		mkdirSync(directory, { recursive: true, mode: STORE_DIR_MODE });
		const payload: CatalogCache = { version: 1, userId, ids: [...ids], updatedAt: Date.now() };
		writeFileSync(catalogPath(storePath), `${JSON.stringify(payload)}\n`, { mode: STORE_FILE_MODE });
	} catch {
		// A read-only home keeps the in-memory list for this process.
	}
}
