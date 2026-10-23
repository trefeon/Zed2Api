/**
 * The `x-zed-version` value and the minimum the edge demands.
 *
 * The cloud edge rejects stale clients, so a hardcoded version rots. The value
 * is resolved from the latest stable `zed-industries/zed` release, cached for
 * six hours on disk, and refreshed in the background only for real upstream
 * traffic: tests and `ZED_API_BASE` runs (the mock upstream) never touch the
 * network. A response carrying `x-zed-minimum-required-version` raises the
 * cached value immediately, which is how the plugin notices a forced upgrade
 * without a release of its own.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_DIR_MODE, STORE_FILE_MODE, storeDirectory } from "../accounts.ts";

/** Last release this package was verified against; used until the cache fills. */
export const FALLBACK_CLIENT_VERSION = "1.25.2";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const RELEASE_URL = "https://api.github.com/repos/zed-industries/zed/releases?per_page=20";
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const TAG_PATTERN = /^v?(\d+\.\d+\.\d+)$/;

let memory: { version: string; fetchedAt: number } | null = null;
let refreshing: Promise<string> | null = null;

interface ReleaseEntry {
	tag_name?: unknown;
	prerelease?: unknown;
	draft?: unknown;
}

function cachePath(): string {
	return join(storeDirectory(), "client-version.json");
}

function compare(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function validVersion(value: unknown): value is string {
	return typeof value === "string" && VERSION_PATTERN.test(value.trim());
}

function readCache(): { version: string; fetchedAt: number } | null {
	if (memory) return memory;
	try {
		const parsed: unknown = JSON.parse(readFileSync(cachePath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as { version?: unknown; fetchedAt?: unknown };
		if (!validVersion(record.version) || typeof record.fetchedAt !== "number") return null;
		memory = { version: record.version.trim(), fetchedAt: record.fetchedAt };
		return memory;
	} catch {
		return null;
	}
}

function writeCache(version: string, fetchedAt: number): void {
	memory = { version, fetchedAt };
	try {
		mkdirSync(storeDirectory(), { recursive: true, mode: STORE_DIR_MODE });
		writeFileSync(cachePath(), `${JSON.stringify(memory)}\n`, { mode: STORE_FILE_MODE });
	} catch {
		// A read-only home keeps the in-memory value for this process.
	}
}

/**
 * The best version known without touching the network: env override, memory,
 * a fresh or stale disk cache, then the verified fallback.
 */
export function currentClientVersion(): string {
	const override = process.env.ZED2API_CLIENT_VERSION?.trim();
	if (validVersion(override)) return override;
	return readCache()?.version ?? FALLBACK_CLIENT_VERSION;
}

async function fetchLatestStable(): Promise<string | null> {
	try {
		const response = await fetch(RELEASE_URL, {
			headers: {
				// GitHub rejects requests without a User-Agent; this one never reaches Zed.
				"user-agent": "pi-zed-provider",
				accept: "application/vnd.github+json",
			},
			signal: AbortSignal.timeout(4_000),
		});
		if (!response.ok) return null;
		const payload: unknown = await response.json();
		if (!Array.isArray(payload)) return null;
		for (const entry of payload as ReleaseEntry[]) {
			if (entry.draft === true || entry.prerelease === true) continue;
			if (typeof entry.tag_name !== "string") continue;
			const match = TAG_PATTERN.exec(entry.tag_name.trim());
			if (match?.[1]) return match[1];
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Resolve the version for the next upstream request. A fresh cache answers
 * immediately; otherwise one shared refresh runs (bounded to 4s), and the
 * previous value or fallback is used if the lookup fails.
 */
export function resolveClientVersion(): Promise<string> {
	const override = process.env.ZED2API_CLIENT_VERSION?.trim();
	if (validVersion(override)) return Promise.resolve(override);
	const cached = readCache();
	if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.version);
	refreshing ??= fetchLatestStable()
		.then((latest) => {
			if (!latest) return cached?.version ?? FALLBACK_CLIENT_VERSION;
			// Never downgrade below a minimum the edge already demanded.
			const version = cached && compare(cached.version, latest) > 0 ? cached.version : latest;
			writeCache(version, Date.now());
			return version;
		})
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
}

/** Adopt a minimum the upstream named, immediately, when it is newer. */
export function noteMinimumVersion(value: string | null): void {
	const minimum = value?.trim();
	if (!validVersion(minimum)) return;
	const cached = readCache();
	if (cached && compare(cached.version, minimum) >= 0 && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return;
	writeCache(minimum, Date.now());
}

/** Test seam: forget the in-memory cache (disk is untouched). */
export function resetClientVersionCache(): void {
	memory = null;
	refreshing = null;
}
