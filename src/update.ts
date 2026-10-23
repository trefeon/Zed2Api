/**
 * Self-update for the extension itself.
 *
 * The plugin is installed by a host package manager (`omp plugin install`,
 * `pi install npm:pi-zed-provider`), so it never overwrites its own files: it
 * asks that package manager to do the upgrade and then verifies the version
 * that landed. A source checkout is reported, never pulled — silently moving
 * someone's working tree is not an updater's business.
 *
 * The shape follows `src/zed/clientVersion.ts`: a TTL disk cache beside the
 * account store, one shared in-flight request, a bounded fetch, and every
 * failure contained. Failures are remembered for a day so a broken registry or
 * a broken host CLI cannot spawn a subprocess on every session start.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultStorePath, STORE_DIR_MODE, STORE_FILE_MODE } from "./accounts.ts";

export const PACKAGE_NAME = "pi-zed-provider";

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
/** A good answer is reused this long; a failed one waits the longer retry window. */
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;
const OUTPUT_LIMIT = 4_000;

/** Where the loaded copy lives, and therefore how it can be upgraded. */
export type InstallKind = "omp" | "pi" | "git" | "unknown";

export interface InstallInfo {
	kind: InstallKind;
	root: string;
	version: string;
}

/** Everything the next session needs to know, cached beside the account store. */
export interface UpdateState {
	version: 1;
	checkedAt: number;
	latest: string | null;
	attemptedAt: number;
	attemptedVersion: string | null;
	updatedAt: number;
	lastError: string | null;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<{ code: number; output: string }>;

export type UpdateStatus = "current" | "updated" | "failed" | "unavailable" | "throttled" | "unmanaged" | "locked" | "disabled";

export interface UpdateResult {
	status: UpdateStatus;
	current: string;
	latest?: string;
	detail?: string;
}

export interface UpdateCheck {
	current: string;
	latest: string | null;
	error: string | null;
}

export interface UpdateOptions {
	root?: string;
	storePath?: string;
	fetchImpl?: typeof fetch;
	exec?: CommandRunner;
	now?: () => number;
	/** Ignore the TTL and ask the registry now. */
	force?: boolean;
}

let inflight: Promise<UpdateCheck> | null = null;

/** Test seam: forget the shared in-flight request. */
export function resetUpdateMemory(): void {
	inflight = null;
}

/** The directory holding this package (the parent of `src/`). */
export function packageRoot(): string {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

/** The `version` field of a parsed JSON object, when it is a plain release. */
function versionField(value: unknown): string | null {
	if (typeof value !== "object" || value === null || !("version" in value)) return null;
	const version = value.version;
	return typeof version === "string" && VERSION_PATTERN.test(version.trim()) ? version.trim() : null;
}

export function readPackageVersion(root: string): string {
	try {
		return versionField(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))) ?? "0.0.0";
	} catch {
		// An unreadable manifest cannot be compared or verified.
		return "0.0.0";
	}
}

export function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const diff = (a[index] ?? 0) - (b[index] ?? 0);
		if (Number.isNaN(diff)) return 0;
		if (diff !== 0) return diff;
	}
	return 0;
}

export function detectInstall(root = packageRoot()): InstallInfo {
	const version = readPackageVersion(root);
	// A checkout is checked first: a dev link into a host plugin directory is
	// still a working tree that must not be replaced by a tarball.
	if (existsSync(join(root, ".git"))) return { kind: "git", root, version };
	const path = root.replace(/\\/g, "/").toLowerCase();
	if (path.includes("/.omp/plugins/")) return { kind: "omp", root, version };
	if (path.includes("/.pi/agent/")) return { kind: "pi", root, version };
	return { kind: "unknown", root, version };
}

function blankState(): UpdateState {
	return { version: 1, checkedAt: 0, latest: null, attemptedAt: 0, attemptedVersion: null, updatedAt: 0, lastError: null };
}

function merge(state: UpdateState | null, patch: Partial<UpdateState>): UpdateState {
	return { ...(state ?? blankState()), ...patch, version: 1 };
}

export function readUpdateState(storePath = defaultStorePath()): UpdateState | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dirname(storePath), "update-check.json"), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Partial<UpdateState>;
		if (record.version !== 1 || typeof record.checkedAt !== "number") return null;
		return merge(null, {
			checkedAt: record.checkedAt,
			latest: typeof record.latest === "string" && VERSION_PATTERN.test(record.latest) ? record.latest : null,
			attemptedAt: typeof record.attemptedAt === "number" ? record.attemptedAt : 0,
			attemptedVersion: typeof record.attemptedVersion === "string" ? record.attemptedVersion : null,
			updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
			lastError: typeof record.lastError === "string" ? record.lastError : null,
		});
	} catch {
		return null;
	}
}

function writeUpdateState(state: UpdateState, storePath: string): void {
	try {
		mkdirSync(dirname(storePath), { recursive: true, mode: STORE_DIR_MODE });
		writeFileSync(join(dirname(storePath), "update-check.json"), `${JSON.stringify(state)}\n`, { mode: STORE_FILE_MODE });
	} catch {
		// A read-only home keeps the result for this process only.
	}
}

async function fetchLatestVersion(fetchImpl: typeof fetch): Promise<string> {
	const response = await fetchImpl(REGISTRY_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`registry answered HTTP ${response.status}`);
	const version = versionField(await response.json());
	if (version === null) throw new Error("registry returned no usable version");
	return version;
}

/** One shared registry request per process; a fresh cache answers from disk. */
export function checkForUpdate(options: UpdateOptions = {}): Promise<UpdateCheck> {
	inflight ??= performCheck(options).finally(() => {
		inflight = null;
	});
	return inflight;
}

async function performCheck(options: UpdateOptions): Promise<UpdateCheck> {
	const clock = options.now ?? Date.now;
	const storePath = options.storePath ?? defaultStorePath();
	const current = detectInstall(options.root).version;
	const cached = readUpdateState(storePath);
	const timestamp = clock();
	if (options.force !== true && cached !== null && cached.checkedAt > 0 && timestamp - cached.checkedAt < CHECK_TTL_MS) {
		return { current, latest: cached.latest, error: null };
	}
	try {
		const latest = await fetchLatestVersion(options.fetchImpl ?? fetch);
		writeUpdateState(merge(cached, { checkedAt: timestamp, latest, lastError: null }), storePath);
		return { current, latest, error: null };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Keep the last known release: a network blip must not hide a known update.
		writeUpdateState(merge(cached, { checkedAt: timestamp, lastError: message }), storePath);
		return { current, latest: cached?.latest ?? null, error: message };
	}
}

function upgradePlan(kind: InstallKind): { command: string; args: string[] } | null {
	switch (kind) {
		case "omp":
			return { command: "omp", args: ["plugin", "upgrade", PACKAGE_NAME] };
		case "pi":
			return { command: "pi", args: ["update", `npm:${PACKAGE_NAME}`] };
		default:
			return null;
	}
}

/**
 * Check, then upgrade in place when a host package manager owns the install.
 * Silent by contract: the caller decides whether the result deserves a notice.
 */
export async function maybeAutoUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
	const clock = options.now ?? Date.now;
	const storePath = options.storePath ?? defaultStorePath();
	const install = detectInstall(options.root);
	if (process.env.ZED2API_SKIP_UPDATE_CHECK) return { status: "disabled", current: install.version };

	const check = await checkForUpdate(options);
	if (check.latest === null) {
		return { status: "unavailable", current: check.current, detail: check.error ?? "registry unavailable" };
	}
	if (compareVersions(check.latest, check.current) <= 0) {
		return { status: "current", current: check.current, latest: check.latest };
	}

	const state = readUpdateState(storePath);
	const timestamp = clock();
	if (state !== null && state.attemptedVersion === check.latest) {
		// Applied by this install already; the running process stays on the old
		// code until the host restarts, so there is nothing left to do here.
		if (state.lastError === null) return { status: "current", current: check.current, latest: check.latest };
		if (timestamp - state.attemptedAt < RETRY_AFTER_FAILURE_MS) {
			return { status: "throttled", current: check.current, latest: check.latest, detail: state.lastError };
		}
	}

	const plan = upgradePlan(install.kind);
	if (plan === null) {
		return { status: "unmanaged", current: check.current, latest: check.latest, detail: install.kind };
	}

	const lock = acquireLock(storePath);
	if (lock === null) return { status: "locked", current: check.current, latest: check.latest };

	try {
		const outcome = await (options.exec ?? runCommand)(plan.command, plan.args, install.root);
		if (outcome.code !== 0) {
			const detail = `${plan.command} exited ${outcome.code}: ${outcome.output}`.trim();
			recordFailure(storePath, check.latest, timestamp, detail);
			return { status: "failed", current: check.current, latest: check.latest, detail };
		}
		// The package manager's exit code is not the proof; the manifest is.
		const installed = readPackageVersion(install.root);
		if (compareVersions(installed, check.latest) < 0) {
			const detail = `${plan.command} finished but ${install.root} still reports ${installed}`;
			recordFailure(storePath, check.latest, timestamp, detail);
			return { status: "failed", current: check.current, latest: check.latest, detail };
		}
		writeUpdateState(merge(readUpdateState(storePath), {
			attemptedAt: timestamp,
			attemptedVersion: check.latest,
			updatedAt: timestamp,
			lastError: null,
		}), storePath);
		return { status: "updated", current: check.current, latest: installed, detail: install.root };
	} finally {
		releaseLock(lock);
	}
}

function recordFailure(storePath: string, latest: string, timestamp: number, detail: string): void {
	writeUpdateState(merge(readUpdateState(storePath), {
		attemptedAt: timestamp,
		attemptedVersion: latest,
		lastError: detail,
	}), storePath);
}

function acquireLock(storePath: string): string | null {
	const path = join(dirname(storePath), "update.lock");
	try {
		mkdirSync(dirname(storePath), { recursive: true, mode: STORE_DIR_MODE });
		closeSync(openSync(path, "wx", STORE_FILE_MODE));
		return path;
	} catch {
		try {
			// Staleness is measured on the real clock, not the injected one.
			if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
				unlinkSync(path);
				closeSync(openSync(path, "wx", STORE_FILE_MODE));
				return path;
			}
		} catch {
			// A vanished or unreadable lock is not worth a second attempt.
		}
		return null;
	}
}

function releaseLock(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already released.
	}
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ code: number; output: string }> {
	const { promise, resolve } = Promise.withResolvers<{ code: number; output: string }>();
	const child = spawn(command, args, {
		cwd,
		// Host CLIs are `.cmd` shims on Windows; without a shell they never start.
		shell: process.platform === "win32",
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (chunk: Buffer | string) => {
		if (output.length < OUTPUT_LIMIT) output += chunk.toString();
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const timer = setTimeout(() => {
		child.kill();
		resolve({ code: -1, output: `${output.trim()}\n(timed out after ${UPGRADE_TIMEOUT_MS / 1000}s)` });
	}, UPGRADE_TIMEOUT_MS);
	timer.unref();
	child.on("error", (error) => {
		clearTimeout(timer);
		resolve({ code: -1, output: `${output.trim()}\n${error.message}`.trim() });
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		resolve({ code: code ?? -1, output: output.trim() });
	});
	return promise;
}

export function formatUpdateResult(result: UpdateResult): string {
	const latest = result.latest ?? "unknown";
	switch (result.status) {
		case "current":
			return `${PACKAGE_NAME} ${result.current} is up to date.`;
		case "updated":
			return `${PACKAGE_NAME} updated ${result.current} → ${latest}. Restart the host to load it.`;
		case "failed":
			return `${PACKAGE_NAME} auto-update to ${latest} failed: ${result.detail ?? "unknown error"}`;
		case "unavailable":
			return `Could not check npm for a ${PACKAGE_NAME} update: ${result.detail ?? "registry unavailable"}`;
		case "throttled":
			return `${PACKAGE_NAME} ${latest} is available (installed ${result.current}); automatic upgrade paused after a failure — /zed update to retry.`;
		case "unmanaged":
			return result.detail === "git"
				? `${PACKAGE_NAME} ${latest} is available (installed ${result.current}); this copy is a source checkout — update it with git pull.`
				: `${PACKAGE_NAME} ${latest} is available (installed ${result.current}); install it with omp plugin install ${PACKAGE_NAME} or pi install npm:${PACKAGE_NAME} to receive updates.`;
		case "locked":
			return `${PACKAGE_NAME} is already being upgraded by another process.`;
		default:
			return "";
	}
}

/** The cached update, if any, for a status report. Never touches the network. */
export function pendingUpdate(storePath = defaultStorePath(), current = detectInstall().version): string | null {
	const state = readUpdateState(storePath);
	if (state === null || state.latest === null) return null;
	if (compareVersions(state.latest, current) <= 0) return null;
	return `${PACKAGE_NAME} ${state.latest} is available (installed ${current}); it upgrades at session start, or now with /zed update.`;
}
