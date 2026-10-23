/**
 * Local usage ledger, Zed's published price table, and the opt-in dashboard
 * summary. The ledger is what survives a crash; the dashboard is the exact
 * server-side meter and needs its own web session cookie.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	costFor,
	formatUsageReport,
	loadPlan,
	monthStart,
	normalizePlan,
	ratesFor,
	readUsage,
	recordTurn,
	summarizeUsage,
	usagePath,
	type UsageRecord,
} from "../src/usage.ts";
import { dashboardCookie, fetchDashboardUsage } from "../src/zed/dashboard.ts";

function tempStorePath(): string {
	return join(mkdtempSync(join(tmpdir(), "zed2api-usage-")), "accounts.json");
}

const savedUsageFile = process.env.ZED_USAGE_FILE;
const savedCookie = process.env.ZED_DASHBOARD_COOKIE;
afterEach(() => {
	if (savedUsageFile === undefined) delete process.env.ZED_USAGE_FILE;
	else process.env.ZED_USAGE_FILE = savedUsageFile;
	if (savedCookie === undefined) delete process.env.ZED_DASHBOARD_COOKIE;
	else process.env.ZED_DASHBOARD_COOKIE = savedCookie;
});

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return {
		ts: Date.now(),
		account: "main",
		userId: "user-main",
		organizationId: "org_1",
		model: "gpt-5.6-luna",
		input: 1_000,
		output: 500,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: 0.00088,
		...overrides,
	};
}

describe("Zed price table", () => {
	test("matches exact models and their dated suffixes", () => {
		expect(ratesFor("gpt-5.6-luna")?.input).toBe(0.22);
		expect(ratesFor("gpt-5.6-luna-20260101")?.output).toBe(1.32);
		expect(ratesFor("claude-sonnet-5-5")?.cacheWrite).toBe(2.75);
		expect(ratesFor("gemini-3.1-pro-preview")?.input).toBe(2.2);
		expect(ratesFor("unknown-model")).toBeNull();
	});

	test("prices input, output and cache at the published per-million rates", () => {
		expect(costFor("gpt-5.6-luna", { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(
			1.54,
			10,
		);
		expect(
			costFor("claude-sonnet-5", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 }),
		).toBeCloseTo(2.97, 10);
		expect(costFor("unknown-model", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
	});
});

describe("usage ledger", () => {
	test("appends, reads and filters turns without failing on bad lines", () => {
		const storePath = tempStorePath();
		const path = usagePath(storePath);
		expect(path.endsWith("usage.jsonl")).toBe(true);

		recordTurn(storePath, record({ ts: 1_700_000_000_000 }));
		recordTurn(storePath, record({ ts: 1_800_000_000_000, model: "gpt-5.6-sol", costUsd: null }));
		appendFileSync(path, "{not json}\n\n");

		const records = readUsage(storePath);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({ model: "gpt-5.6-luna", account: "main", input: 1_000 });
		expect(records[1]?.costUsd).toBeNull();

		const summary = summarizeUsage(records, 1_750_000_000_000);
		expect(summary.turns).toBe(1);
		expect(summary.byModel[0]?.model).toBe("gpt-5.6-sol");
		expect(summary.unknownCostTurns).toBe(1);
	});

	test("monthStart uses the local calendar month", () => {
		const start = new Date(monthStart(new Date(2026, 9, 23)));
		expect(start.getFullYear()).toBe(2026);
		expect(start.getMonth()).toBe(9);
		expect(start.getDate()).toBe(1);
		expect(start.getHours()).toBe(0);
	});

	test("renders dashboard edit prediction usage", () => {
		const storePath = tempStorePath();
		recordTurn(storePath, record());
		const summary = summarizeUsage(readUsage(storePath), 0);
		const text = formatUsageReport(summary, {
			plan: "student",
			dashboard: {
				plan: "zed_student",
				isAccountTooYoung: false,
				currentUsage: {
					tokenSpend: { spendInCents: 0, limitInCents: 1000, updatedAt: null },
					editPredictions: { used: 0, limit: null, remaining: null },
				},
				portalUrl: null,
			},
		});
		expect(text).toContain("Edit predictions: 0 used of unlimited (unlimited remaining)");
	});

	test("formats totals and states the plan credit", () => {
		const storePath = tempStorePath();
		recordTurn(storePath, record());
		const summary = summarizeUsage(readUsage(storePath), 0);
		const student = formatUsageReport(summary, { plan: "student" });
		expect(student).toContain("gpt-5.6-luna");
		expect(student).toContain("$10.00/month");
		expect(student).toContain("Estimated local cost");
		expect(formatUsageReport(summary, { plan: "pro" })).toContain("$5.00/month");
	});

	test("normalizes plan names and reads the local plan file", () => {
		expect(normalizePlan("zed_student")).toBe("student");
		expect(normalizePlan("zed_pro_trial")).toBe("trial");
		expect(normalizePlan("zed_business")).toBe("business");
		expect(normalizePlan("unknown")).toBeNull();
		const storePath = tempStorePath();
		delete process.env.ZED_PLAN;
		writeFileSync(join(dirname(storePath), "plan"), "student\n");
		expect(loadPlan(storePath)).toBe("student");
		process.env.ZED_PLAN = "pro";
		expect(loadPlan(storePath)).toBe("pro");
	});
});

describe("dashboard usage", () => {
	test("reads the cookie from the environment and strips a Cookie prefix", () => {
		const storePath = tempStorePath();
		process.env.ZED_DASHBOARD_COOKIE = 'Cookie: "session=abc; other=1"';
		expect(dashboardCookie(storePath)).toBe("session=abc; other=1");
	});

	test("reads the cookie file when the environment has none", () => {
		const storePath = tempStorePath();
		delete process.env.ZED_DASHBOARD_COOKIE;
		// The cookie lives beside the account store.
		writeFileSync(join(dirname(storePath), "dashboard-cookie"), "session=file\n");
		expect(dashboardCookie(storePath)).toBe("session=file");
	});

	test("parses the dashboard summary and sends the session cookie", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({
				url: String(input),
				headers: Object.fromEntries(new Headers(init?.headers).entries()),
			});
			return new Response(
				JSON.stringify({
					plan: "zed_pro",
					is_account_too_young: false,
					current_usage: {
						token_spend: { spend_in_cents: 1234, limit_in_cents: 1000, updated_at: "2026-10-23T00:00:00Z" },
						edit_predictions: { used: 0, limit: null, remaining: null },
					},
					portal_url: "https://billing.example/portal",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as typeof fetch;

		const usage = await fetchDashboardUsage(fakeFetch, "session=abc");
		expect(usage).toEqual({
			plan: "zed_pro",
			isAccountTooYoung: false,
			currentUsage: {
				tokenSpend: { spendInCents: 1234, limitInCents: 1000, updatedAt: "2026-10-23T00:00:00Z" },
				editPredictions: { used: 0, limit: null, remaining: null },
			},
			portalUrl: "https://billing.example/portal",
		});
		expect(calls[0]?.url).toBe("https://cloud.zed.dev/frontend/billing/usage");
		expect(calls[0]?.headers["cookie"]).toBe("session=abc");
		expect(calls[0]?.headers["origin"]).toBe("https://dashboard.zed.dev");
	});

	test("reports an expired dashboard session without leaking the response", async () => {
		const fakeFetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
		await expect(fetchDashboardUsage(fakeFetch, "session=old")).rejects.toThrow("not authorized");
	});
});
