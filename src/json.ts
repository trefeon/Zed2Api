/**
 * Narrowing helpers for parsed JSON.
 *
 * Everything crossing a runtime boundary — upstream responses, account files —
 * arrives as `unknown`. These helpers narrow it once with `typeof`/`in` checks
 * so callers read checked values instead of asserting shapes per access.
 */

export type JsonRecord = Record<string, unknown>;

/** The one place a narrowed object gains an index signature, for dynamic keys. */
export function asRecord(value: unknown): JsonRecord | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as JsonRecord;
}

export function readString(record: JsonRecord, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

export function readNumber(record: JsonRecord, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readRecord(record: JsonRecord, key: string): JsonRecord | null {
	return asRecord(record[key]);
}

export function readArray(record: JsonRecord, key: string): unknown[] | null {
	const value = record[key];
	return Array.isArray(value) ? value : null;
}
