/**
 * Stable device identity for `x-zed-system-id`.
 *
 * Zed's client sends its installation's telemetry system id on the token and
 * user-info calls; the id is generated once per install and reused. Reusing one
 * well-known value across every plugin user is a stronger correlation signal
 * than sending the header at all, so this file owns a per-install UUID:
 * `ZED2API_SYSTEM_ID` wins when set, otherwise `system-id` beside the account
 * store, generated on first use.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_DIR_MODE, STORE_FILE_MODE, storeDirectory } from "../accounts.ts";

const SYSTEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cached: string | null = null;

export function resolveSystemId(): string {
	const override = process.env.ZED2API_SYSTEM_ID?.trim();
	if (override && SYSTEM_ID_PATTERN.test(override)) return override.toLowerCase();
	if (cached) return cached;

	const file = join(storeDirectory(), "system-id");
	try {
		const existing = readFileSync(file, "utf8").trim();
		if (SYSTEM_ID_PATTERN.test(existing)) {
			cached = existing.toLowerCase();
			return cached;
		}
	} catch {
		// First run, or an unreadable store; a fresh id is the correct fallback.
	}

	const fresh = randomUUID();
	try {
		mkdirSync(storeDirectory(), { recursive: true, mode: STORE_DIR_MODE });
		writeFileSync(file, `${fresh}\n`, { mode: STORE_FILE_MODE });
		chmodSync(file, STORE_FILE_MODE);
	} catch {
		// A read-only home still gets a working id for this process.
	}
	cached = fresh;
	return fresh;
}
