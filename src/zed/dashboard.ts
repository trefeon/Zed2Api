/**
 * Exact plan usage from Zed's dashboard API.
 *
 * The native app credential cannot read this endpoint (it is cookie-authenticated
 * and answers 401 to the account token), so the cookie is explicitly opt-in:
 * `ZED_DASHBOARD_COOKIE` or `<store dir>/dashboard-cookie`, containing the
 * `Cookie:` header value from a signed-in dashboard.zed.dev request.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { asRecord, readNumber, readString } from "../json.ts";

export const DASHBOARD_USAGE_URL = "https://cloud.zed.dev/frontend/billing/usage";

export interface DashboardTokenSpend {
	spendInCents: number;
	limitInCents: number | null;
	updatedAt: string | null;
}

export interface DashboardEditPredictions {
	used: number;
	limit: number | null;
	remaining: number | null;
}

export interface DashboardUsage {
	plan: string;
	isAccountTooYoung: boolean;
	currentUsage: {
		tokenSpend: DashboardTokenSpend;
		editPredictions: DashboardEditPredictions | null;
	} | null;
	portalUrl: string | null;
}

function cleanCookie(value: string): string | null {
	let cookie = value.trim();
	if (/^cookie:/i.test(cookie)) cookie = cookie.slice(7).trim();
	if (
		(cookie.startsWith('"') && cookie.endsWith('"')) ||
		(cookie.startsWith("'") && cookie.endsWith("'"))
	) {
		cookie = cookie.slice(1, -1).trim();
	}
	return cookie.length > 0 ? cookie : null;
}

/** Opt-in dashboard session: environment first, then the store directory. */
export function dashboardCookie(storePath: string): string | null {
	const fromEnv = process.env.ZED_DASHBOARD_COOKIE;
	if (fromEnv !== undefined) return cleanCookie(fromEnv);
	const path = join(dirname(storePath), "dashboard-cookie");
	if (!existsSync(path)) return null;
	try {
		return cleanCookie(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export function dashboardUsageUrl(organizationId: string | null): string {
	return organizationId
		? `https://dashboard.zed.dev/${organizationId}/billing/usage`
		: "https://dashboard.zed.dev/";
}

/**
 * Read the dashboard's own summary. Throws with a user-facing reason; callers
 * fall back to the local ledger.
 */
export async function fetchDashboardUsage(
	fetchImpl: typeof fetch,
	cookie: string,
	signal?: AbortSignal,
): Promise<DashboardUsage> {
	const response = await fetchImpl(DASHBOARD_USAGE_URL, {
		headers: {
			cookie,
			accept: "application/json",
			origin: "https://dashboard.zed.dev",
			referer: "https://dashboard.zed.dev/",
			"user-agent":
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		},
		signal,
	});
	if (!response.ok) {
		if (response.status === 401) {
			throw new Error("dashboard session is not authorized (refresh the Cookie header)");
		}
		throw new Error(`dashboard returned HTTP ${response.status}`);
	}
	let raw: unknown;
	try {
		raw = await response.json();
	} catch {
		throw new Error("dashboard returned invalid JSON");
	}
	const record = asRecord(raw);
	if (!record) throw new Error("dashboard returned an unexpected shape");

	const usageRecord = asRecord(record["current_usage"]);
	let currentUsage: DashboardUsage["currentUsage"] = null;
	if (usageRecord) {
		const spend = asRecord(usageRecord["token_spend"]) ?? {};
		const predictions = asRecord(usageRecord["edit_predictions"]);
		currentUsage = {
			tokenSpend: {
				spendInCents: readNumber(spend, "spend_in_cents") ?? 0,
				limitInCents: readNumber(spend, "limit_in_cents"),
				updatedAt: readString(spend, "updated_at"),
			},
			editPredictions: predictions
				? {
						used: readNumber(predictions, "used") ?? 0,
						limit: readNumber(predictions, "limit"),
						remaining: readNumber(predictions, "remaining"),
					}
				: null,
		};
	}

	return {
		plan: readString(record, "plan") ?? "unknown",
		isAccountTooYoung: record["is_account_too_young"] === true,
		currentUsage,
		portalUrl: readString(record, "portal_url"),
	};
}
