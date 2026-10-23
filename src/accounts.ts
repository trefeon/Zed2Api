/**
 * Account storage and rotation, ported from the reference gateway.
 *
 * On-disk format is the gateway's, so an accounts.json can be shared between
 * the plugin and the reference proxy:
 *   { "<name>": { "user_id": "<id>", "credential": <raw credential JSON> } }
 *
 * Rotation policy (same cooldowns as the gateway): auth failures bench an
 * account for 5 minutes and three in a row bench it for an hour; rate limits
 * for 30 seconds; transient faults only after three in a row, for 20 seconds.
 * A request still falls back to benched accounts when every account is
 * benched, so a stale cooldown never hard-fails a turn.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { asRecord } from "./json.ts";
import { fetchAccountIdentity, fetchLlmToken, TOKEN_EXPIRY_SKEW_S, ZedTokenError } from "./zed/token.ts";

/** The store directory is private to the user; POSIX only, Windows ignores it. */
export const STORE_DIR_MODE = 0o700;
/** The store file holds a credential, so it is owner-read/write only. */
export const STORE_FILE_MODE = 0o600;

/**
 * Narrow a file or directory back to `mode` when it was created wider (an
 * older release, or a `cp` that widened it). Best effort: a read-only mount or
 * a vanished path must not fail the caller.
 */
function restrictPermissions(target: string, mode: number): void {
	try {
		if ((statSync(target).mode & 0o777 & ~mode) !== 0) chmodSync(target, mode);
	} catch {
		// Nothing to repair, or no permission to repair it.
	}
}

export type FailureKind = "auth" | "rate_limit" | "transient";
export type ProbeState = "unchecked" | "healthy" | "auth_error" | "rate_limited" | "upstream_error";

const AUTH_COOLDOWN_S = 300;
const RATE_LIMIT_COOLDOWN_S = 30;
const TRANSIENT_COOLDOWN_S = 20;
const TRANSIENT_TRIP_THRESHOLD = 3;
const DEAD_CREDENTIAL_THRESHOLD = 3;
const DEAD_CREDENTIAL_COOLDOWN_S = 3600;

export interface AccountState {
	name: string;
	userId: string;
	/** Credential blob exactly as Zed issued it; also the token-endpoint secret. */
	credential: string;
	/** Organization the token request names; resolved from user info on first use. */
	organizationId: string | null;
	jwtToken: string | null;
	jwtExpiresAt: number;
	/** Unix seconds until which the scheduler skips this account; 0 = healthy. */
	disabledUntil: number;
	consecutiveFailures: number;
	lastStatus: number;
	lastOk: number;
	probeState: ProbeState;
	probeAt: number;
	probeLatencyMs: number;
}

export function defaultStorePath(): string {
	const override = process.env.ZED_ACCOUNTS_FILE;
	if (override) return override;
	return join(homedir(), ".zed2api", "accounts.json");
}

/** Directory holding the account store plus the client's identity files. */
export function storeDirectory(): string {
	return dirname(defaultStorePath());
}

function emptyAccount(name: string, userId: string, credential: string, organizationId: string | null = null): AccountState {
	return {
		name,
		userId,
		credential,
		organizationId,
		jwtToken: null,
		jwtExpiresAt: 0,
		disabledUntil: 0,
		consecutiveFailures: 0,
		lastStatus: 0,
		lastOk: 0,
		probeState: "unchecked",
		probeAt: 0,
		probeLatencyMs: 0,
	};
}

export interface AccountSummary {
	name: string;
	current: boolean;
	healthy: boolean;
	cooldownSeconds: number;
	consecutiveFailures: number;
	lastStatus: number;
	probeState: ProbeState;
}

export class AccountStore {
	#filePath: string;
	#accounts: AccountState[] = [];
	#current = 0;
	#refreshes = new Map<string, Promise<string>>();

	constructor(filePath: string = defaultStorePath()) {
		this.#filePath = filePath;
	}

	/** The resolved store file, so a caller can tell the user which file to fix. */
	get path(): string {
		return this.#filePath;
	}

	get length(): number {
		return this.#accounts.length;
	}

	names(): string[] {
		return this.#accounts.map((account) => account.name);
	}

	load(): void {
		this.#accounts = [];
		if (!existsSync(this.#filePath)) return;
		// Repair a file saved by an older release, before anything reads it.
		restrictPermissions(this.#filePath, STORE_FILE_MODE);
		const text = readFileSync(this.#filePath, "utf8");
		// PowerShell's `Set-Content -Encoding UTF8` prepends a BOM to a
		// hand-authored file; that file is valid, only JSON.parse minds.
		const json = text.startsWith("\uFEFF") ? text.slice(1) : text;
		let raw: unknown;
		try {
			raw = JSON.parse(json);
		} catch (error) {
			// A store we cannot parse is never overwritten: the caller reports the
			// problem and refuses to mutate the file until the user repairs it.
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`store file is not valid JSON: ${reason}`);
		}
		if (typeof raw !== "object" || raw === null) return;

		for (const [name, value] of Object.entries(raw)) {
			const entry = asRecord(value);
			if (!entry) continue;
			const userId = entry["user_id"];
			if (typeof userId !== "string") continue;
			// The gateway stores the credential as raw JSON; older files may hold
			// it as a plain string. Both end up as the header value.
			const stored = entry["credential"];
			const credential = typeof stored === "string" ? stored : JSON.stringify(stored ?? null);
			const organization = entry["organization_id"];
			this.#accounts.push(emptyAccount(name, userId, credential, typeof organization === "string" ? organization : null));
		}

		const remembered = this.#readActiveName();
		const rememberedIndex = remembered === null ? -1 : this.#accounts.findIndex((a) => a.name === remembered);
		if (rememberedIndex >= 0) {
			this.#current = rememberedIndex;
			return;
		}
		const healthyIndex = this.#accounts.findIndex((account) => this.available(account));
		this.#current = healthyIndex >= 0 ? healthyIndex : 0;
	}

	#readActiveName(): string | null {
		const activePath = join(dirname(this.#filePath), "active_account.txt");
		if (!existsSync(activePath)) return null;
		try {
			return readFileSync(activePath, "utf8").trim() || null;
		} catch {
			return null;
		}
	}

	#writeActiveName(): void {
		const account = this.current();
		if (!account) return;
		try {
			writeFileSync(join(dirname(this.#filePath), "active_account.txt"), account.name, "utf8");
		} catch {
			// Best effort: a failed bookmark must never break a request.
		}
	}

	save(): void {
		const payload: Record<string, { user_id: string; credential: unknown; organization_id?: string }> = {};
		for (const account of this.#accounts) {
			let parsed: unknown = account.credential;
			try {
				parsed = JSON.parse(account.credential);
			} catch {
				// Keep a non-JSON credential as a string rather than losing it.
			}
			payload[account.name] = {
				user_id: account.userId,
				credential: parsed,
				...(account.organizationId ? { organization_id: account.organizationId } : {}),
			};
		}
		mkdirSync(dirname(this.#filePath), { recursive: true, mode: STORE_DIR_MODE });
		writeFileSync(this.#filePath, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: STORE_FILE_MODE });
		// `mode` only applies at creation, so narrow a file that already existed.
		restrictPermissions(this.#filePath, STORE_FILE_MODE);
	}

	add(name: string, userId: string, credential: string, organizationId: string | null = null): AccountState {
		const existing = this.#accounts.find((account) => account.name === name);
		if (existing) {
			existing.userId = userId;
			existing.credential = credential;
			existing.organizationId = organizationId;
			existing.jwtToken = null;
			existing.jwtExpiresAt = 0;
			existing.disabledUntil = 0;
			existing.consecutiveFailures = 0;
			this.save();
			return existing;
		}
		const account = emptyAccount(name, userId, credential, organizationId);
		this.#accounts.push(account);
		this.save();
		return account;
	}

	remove(name: string): boolean {
		const index = this.#accounts.findIndex((account) => account.name === name);
		if (index < 0) return false;
		this.#accounts.splice(index, 1);
		if (this.#current >= this.#accounts.length) this.#current = Math.max(0, this.#accounts.length - 1);
		this.save();
		return true;
	}

	current(): AccountState | null {
		return this.#accounts[this.#current] ?? null;
	}

	find(name: string): AccountState | null {
		return this.#accounts.find((account) => account.name === name) ?? null;
	}

	switchTo(name: string): boolean {
		const index = this.#accounts.findIndex((account) => account.name === name);
		if (index < 0) return false;
		this.#current = index;
		this.#writeActiveName();
		return true;
	}

	available(account: AccountState, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
		return nowSeconds >= account.disabledUntil;
	}

	/**
	 * Attempt order for one request: the current account when healthy, then the
	 * remaining healthy accounts, then benched accounts soonest-to-recover first.
	 */
	tryOrder(): AccountState[] {
		const now = Math.floor(Date.now() / 1000);
		const healthy = this.#accounts.filter((account) => this.available(account, now));
		const benched = this.#accounts
			.filter((account) => !this.available(account, now))
			.sort((left, right) => left.disabledUntil - right.disabledUntil);
		const current = this.current();
		if (current && this.available(current, now)) {
			return [current, ...healthy.filter((account) => account !== current), ...benched];
		}
		return [...healthy, ...benched];
	}

	markSuccess(account: AccountState, status: number): void {
		account.consecutiveFailures = 0;
		account.disabledUntil = 0;
		account.lastStatus = status;
		account.lastOk = Math.floor(Date.now() / 1000);
	}

	markFailure(account: AccountState, kind: FailureKind, status: number): void {
		account.consecutiveFailures += 1;
		account.lastStatus = status;
		const now = Math.floor(Date.now() / 1000);
		if (kind === "auth") {
			account.disabledUntil =
				account.consecutiveFailures >= DEAD_CREDENTIAL_THRESHOLD
					? now + DEAD_CREDENTIAL_COOLDOWN_S
					: now + AUTH_COOLDOWN_S;
			return;
		}
		if (kind === "rate_limit") {
			account.disabledUntil = now + RATE_LIMIT_COOLDOWN_S;
			return;
		}
		account.disabledUntil = account.consecutiveFailures >= TRANSIENT_TRIP_THRESHOLD ? now + TRANSIENT_COOLDOWN_S : 0;
	}

	markProbe(account: AccountState, state: ProbeState, latencyMs: number, kind: FailureKind | null, status: number): void {
		account.probeState = state;
		account.probeAt = Math.floor(Date.now() / 1000);
		account.probeLatencyMs = latencyMs;
		if (kind === null) this.markSuccess(account, status);
		else this.markFailure(account, kind, status);
	}

	summaries(): AccountSummary[] {
		const now = Math.floor(Date.now() / 1000);
		const current = this.current();
		return this.#accounts.map((account) => ({
			name: account.name,
			current: account === current,
			healthy: this.available(account, now),
			cooldownSeconds: Math.max(0, account.disabledUntil - now),
			consecutiveFailures: account.consecutiveFailures,
			lastStatus: account.lastStatus,
			probeState: account.probeState,
		}));
	}

	/**
	 * A usable JWT for the account, refreshing one minute before expiry.
	 * Concurrent callers share a single refresh (keys are account names, so a
	 * plain object would not do).
	 */
	async tokenFor(account: AccountState, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		if (account.jwtToken && now < account.jwtExpiresAt - TOKEN_EXPIRY_SKEW_S) return account.jwtToken;

		const inFlight = this.#refreshes.get(account.name);
		if (inFlight) return inFlight;

		const refresh = this.ensureOrganization(account, fetchImpl, signal).then((organizationId) => {
			if (!organizationId) {
				throw new ZedTokenError("Zed account has no organization to mint a token for", 400);
			}
			return fetchLlmToken({
				userId: account.userId,
				credential: account.credential,
				organizationId,
				fetchImpl,
				signal,
				nowSeconds: now,
			});
		})
			.then((token) => {
				account.jwtToken = token.token;
				account.jwtExpiresAt = token.expiresAt;
				return token.token;
			})
			.finally(() => {
				this.#refreshes.delete(account.name);
			});

		this.#refreshes.set(account.name, refresh);
		return refresh;
	}

	/**
	 * Resolve and persist the account's organization, and normalize the user id
	 * to the legacy numeric form the Authorization header requires.
	 */
	async ensureOrganization(account: AccountState, fetchImpl?: typeof fetch, signal?: AbortSignal): Promise<string | null> {
		if (account.organizationId) return account.organizationId;
		const identity = await fetchAccountIdentity({
			userId: account.userId,
			credential: account.credential,
			fetchImpl,
			signal,
		});
		let changed = false;
		if (identity.userId && identity.userId !== account.userId) {
			account.userId = identity.userId;
			changed = true;
		}
		if (identity.organizationId) {
			account.organizationId = identity.organizationId;
			changed = true;
		}
		if (changed) this.save();
		return identity.organizationId;
	}

	/** Drop a cached JWT so the next call mints a new one. */
	invalidateToken(account: AccountState): void {
		account.jwtToken = null;
		account.jwtExpiresAt = 0;
	}
}
