/**
 * LLM token acquisition, ported from Zed's `cloud_api_client`.
 *
 * Every completions/models call needs a short-lived JWT minted from the stored
 * credential: POST /client/llm_tokens, authenticated by
 * `<user_id> <credential>`. The body names the account's organization as a
 * string (`OrganizationId`); a null or short value is rejected by the server
 * before the token is issued. The JWT's `exp` claim drives caching; callers
 * refresh one minute before expiry.
 */

import { asRecord } from "../json.ts";
import { currentClientVersion } from "./clientVersion.ts";
import { LLM_TOKENS_URL, USER_INFO_URL, tokenHeaders } from "./constants.ts";
import { wireRequest } from "./http.ts";
import { resolveSystemId } from "./system.ts";

/** Refresh this many seconds before the JWT actually expires. */
export const TOKEN_EXPIRY_SKEW_S = 60;

/** Fallback lifetime when the JWT has no readable `exp` claim. */
const FALLBACK_LIFETIME_S = 300;

export interface ZedToken {
	token: string;
	/** Unix seconds at which the JWT expires. */
	expiresAt: number;
}

export class ZedTokenError extends Error {
	override readonly name = "ZedTokenError";
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

/**
 * Read the `exp` claim out of a JWT without verifying it. Returns null when the
 * token is not a decodable JWT.
 */
export function decodeJwtExpirySeconds(jwt: string): number | null {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	const payload = parts[1];
	if (!payload) return null;
	try {
		const decoded = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
		const claims: unknown = JSON.parse(decoded);
		if (typeof claims !== "object" || claims === null || !("exp" in claims)) return null;
		return typeof claims.exp === "number" ? claims.exp : null;
	} catch {
		return null;
	}
}

export interface AccountInfoOptions {
	userId: string;
	credential: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export interface AccountIdentity {
	/** Organization the token request must name. */
	organizationId: string | null;
	/** Legacy numeric user id the Authorization header requires, when exposed. */
	userId: string | null;
}

/** Account facts the token request needs, resolved from `/client/users/me`. */
export async function fetchAccountIdentity(options: AccountInfoOptions): Promise<AccountIdentity> {
	const response = await wireRequest(
		{
			method: "GET",
			url: USER_INFO_URL,
			headers: tokenHeaders(options.userId, options.credential, resolveSystemId(), currentClientVersion()),
			signal: options.signal,
		},
		options.fetchImpl,
	);
	const text = await response.text();
	if (!response.ok) {
		throw new ZedTokenError(`Zed user lookup failed (HTTP ${response.status}): ${text.slice(0, 300)}`, response.status);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new ZedTokenError(`Zed user endpoint returned non-JSON: ${text.slice(0, 200)}`, response.status);
	}
	const record = asRecord(payload);
	if (!record) return { organizationId: null, userId: null };

	const user = asRecord(record["user"]);
	const legacy = user?.["legacy_user_id"] ?? user?.["id"];
	const userId =
		typeof legacy === "number" ? String(legacy) : typeof legacy === "string" && legacy.length > 0 ? legacy : null;

	let organizationId: string | null = null;
	const preferred = record["default_organization_id"];
	if (typeof preferred === "string" && preferred.length > 0) {
		organizationId = preferred;
	} else {
		const organizations = record["organizations"];
		if (Array.isArray(organizations)) {
			for (const entry of organizations) {
				const organization = asRecord(entry);
				const id = organization?.["id"];
				if (typeof id === "string" && id.length > 0) {
					organizationId = id;
					break;
				}
			}
		}
	}
	return { organizationId, userId };
}

export interface FetchTokenOptions extends AccountInfoOptions {
	organizationId: string;
	nowSeconds?: number;
}

/** Mint a fresh JWT from the stored credential. */
export async function fetchLlmToken(options: FetchTokenOptions): Promise<ZedToken> {
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const response = await wireRequest(
		{
			method: "POST",
			url: LLM_TOKENS_URL,
			headers: tokenHeaders(options.userId, options.credential, resolveSystemId(), currentClientVersion()),
			body: JSON.stringify({ organization_id: options.organizationId }),
			signal: options.signal,
		},
		options.fetchImpl,
	);

	const text = await response.text();
	if (!response.ok) {
		throw new ZedTokenError(`Zed token refresh failed (HTTP ${response.status}): ${text.slice(0, 300)}`, response.status);
	}

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new ZedTokenError(`Zed token endpoint returned non-JSON: ${text.slice(0, 200)}`, response.status);
	}
	if (typeof payload !== "object" || payload === null || !("token" in payload) || typeof payload.token !== "string") {
		throw new ZedTokenError("Zed token endpoint returned no token", response.status);
	}

	const expiresAt = decodeJwtExpirySeconds(payload.token) ?? now + FALLBACK_LIFETIME_S;
	return { token: payload.token, expiresAt };
}
