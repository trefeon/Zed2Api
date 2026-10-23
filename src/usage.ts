/**
 * Local turn ledger and Zed's published hosted-model prices.
 *
 * Zed bills hosted tokens at API list price +10%. The authoritative meter is
 * the dashboard (dashboard.zed.dev), which includes every client; this ledger
 * counts only the turns this provider served, because that is all a host can
 * observe. The two numbers differ by design.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { STORE_DIR_MODE, STORE_FILE_MODE } from "./accounts.ts";
import type { DashboardUsage } from "./zed/dashboard.ts";

/** Prices are US dollars per 1M tokens, from zed.dev/docs/account/zed-hosted-models. */
export interface TokenRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

const rate = (input: number, output: number, cacheRead = 0, cacheWrite = 0): TokenRates => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

export const MODEL_RATES: Record<string, TokenRates> = {
	"claude-fable-5-1": rate(11, 55, 0.275, 13.75),
	"claude-fable-5": rate(11, 55, 1.1, 13.75),
	"claude-opus-5-5": rate(4.4, 22, 0.22, 5.5),
	"claude-opus-5": rate(5.5, 27.5, 0.55, 6.875),
	"claude-opus-4-8": rate(5.5, 27.5, 0.55, 6.875),
	"claude-opus-4-7": rate(5.5, 27.5, 0.55, 6.875),
	"claude-opus-4-6": rate(5.5, 27.5, 0.55, 6.875),
	"claude-opus-4-5": rate(5.5, 27.5, 0.55, 6.875),
	"claude-sonnet-5-5": rate(2.2, 11, 0.22, 2.75),
	"claude-sonnet-5": rate(2.2, 11, 0.22, 2.75),
	"claude-sonnet-4-6": rate(3.3, 16.5, 0.33, 4.125),
	"claude-sonnet-4-5": rate(3.3, 16.5, 0.33, 4.125),
	"claude-haiku-4-5": rate(1.1, 5.5, 0.11, 1.375),
	"gpt-6.1-sol": rate(2.2, 11, 0.11, 2.75),
	"gpt-6-astra": rate(11, 55, 1.1, 13.75),
	"gpt-6-sol": rate(2.2, 11, 0.22, 2.75),
	"gpt-6-luna": rate(0.11, 0.55, 0.011, 0.1375),
	"gpt-5.6-sol": rate(4.4, 22, 0.44, 5.5),
	"gpt-5.6-terra": rate(2.2, 13.2, 0.22, 2.75),
	"gpt-5.6-luna": rate(0.22, 1.32, 0.022, 0.275),
	"gpt-5.6": rate(4.4, 22, 0.44, 5.5),
	"gpt-5.5-pro": rate(33, 198),
	"gpt-5.5": rate(5.5, 33, 0.55),
	"gpt-5.4-pro": rate(33, 198),
	"gpt-5.4": rate(2.75, 16.5, 0.275),
	"gpt-5.3-codex": rate(1.925, 15.4, 0.1925),
	"gpt-5.2-codex": rate(1.925, 15.4, 0.1925),
	"gpt-5.2": rate(1.925, 15.4, 0.1925),
	"gpt-5-mini": rate(0.275, 2.2, 0.0275),
	"gpt-5-nano": rate(0.055, 0.44, 0.0055),
	"gemini-3.1-pro-preview": rate(2.2, 13.2),
	"gemini-3.1-pro": rate(2.2, 13.2),
	"gemini-3.5-flash": rate(1.65, 9.9),
	"gemini-3-flash": rate(0.55, 3.3),
};

/** Longest key first so `claude-sonnet-5-5` cannot match the `5` prefix. */
const RATE_KEYS = Object.keys(MODEL_RATES).sort((a, b) => b.length - a.length);

/**
 * Rates for a model id, including dated or preview suffixes. Unknown models
 * return null and are counted as tokens without a dollar estimate; guessing a
 * price would make the total look more certain than it is.
 */
export function ratesFor(model: string): TokenRates | null {
	const direct = MODEL_RATES[model];
	if (direct) return direct;
	for (const key of RATE_KEYS) {
		if (model.startsWith(`${key}-`)) return MODEL_RATES[key] ?? null;
	}
	return null;
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** Estimated US dollars for one turn, or null when the model has no published rate. */
export function costFor(model: string, usage: TokenUsage): number | null {
	const rates = ratesFor(model);
	if (!rates) return null;
	return (
		(usage.input * rates.input +
			usage.output * rates.output +
			usage.cacheRead * rates.cacheRead +
			usage.cacheWrite * rates.cacheWrite) /
		1_000_000
	);
}

export interface UsageRecord extends TokenUsage {
	/** Epoch milliseconds. */
	ts: number;
	account: string;
	userId: string;
	organizationId: string | null;
	model: string;
	costUsd: number | null;
}

/** `ZED_USAGE_FILE` wins; otherwise the ledger lives beside the account store. */
export function usagePath(storePath: string): string {
	const override = process.env.ZED_USAGE_FILE;
	if (override) return override;
	return join(dirname(storePath), "usage.jsonl");
}

function restrict(target: string, mode: number): void {
	try {
		if ((statSync(target).mode & 0o777 & ~mode) !== 0) chmodSync(target, mode);
	} catch {
		// Nothing to repair, or no permission to repair it.
	}
}

/** Append one turn. Metering must never fail the request that produced it. */
export function recordTurn(storePath: string, record: UsageRecord): void {
	try {
		const path = usagePath(storePath);
		mkdirSync(dirname(path), { recursive: true, mode: STORE_DIR_MODE });
		appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: STORE_FILE_MODE });
		restrict(path, STORE_FILE_MODE);
	} catch {
		// Read-only home, vanished directory, full disk: the turn still stands.
	}
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Parse the ledger, dropping hand-edited or truncated lines instead of failing. */
export function readUsage(storePath: string): UsageRecord[] {
	const path = usagePath(storePath);
	if (!existsSync(path)) return [];
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const records: UsageRecord[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
		const entry = value as Record<string, unknown>;
		const ts = finite(entry["ts"]);
		const input = finite(entry["input"]);
		const output = finite(entry["output"]);
		const account = text(entry["account"]);
		const model = text(entry["model"]);
		const userId = text(entry["userId"]);
		if (ts === null || input === null || output === null || account === null || model === null || userId === null) {
			continue;
		}
		records.push({
			ts,
			account,
			userId,
			organizationId: text(entry["organizationId"]),
			model,
			input,
			output,
			cacheRead: finite(entry["cacheRead"]) ?? 0,
			cacheWrite: finite(entry["cacheWrite"]) ?? 0,
			costUsd: finite(entry["costUsd"]),
		});
	}
	return records;
}

/** Local calendar month; Zed's billing date can differ, so the dashboard is authoritative. */
export function monthStart(now: Date = new Date()): number {
	return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export interface UsageRow {
	model: string;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	unknownCostTurns: number;
}

export interface UsageSummary {
	since: number;
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
	unknownCostTurns: number;
	byModel: UsageRow[];
}

export function summarizeUsage(records: UsageRecord[], since: number): UsageSummary {
	const rows = new Map<string, UsageRow>();
	const summary: UsageSummary = {
		since,
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		costUsd: 0,
		unknownCostTurns: 0,
		byModel: [],
	};
	for (const record of records) {
		if (record.ts < since) continue;
		summary.turns += 1;
		summary.input += record.input;
		summary.output += record.output;
		summary.cacheRead += record.cacheRead;
		summary.cacheWrite += record.cacheWrite;
		if (record.costUsd === null) summary.unknownCostTurns += 1;
		else summary.costUsd += record.costUsd;

		let row = rows.get(record.model);
		if (!row) {
			row = {
				model: record.model,
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				costUsd: 0,
				unknownCostTurns: 0,
			};
			rows.set(record.model, row);
		}
		row.turns += 1;
		row.input += record.input;
		row.output += record.output;
		row.cacheRead += record.cacheRead;
		row.cacheWrite += record.cacheWrite;
		if (record.costUsd === null) row.unknownCostTurns += 1;
		else row.costUsd += record.costUsd;
	}
	summary.byModel = [...rows.values()].sort(
		(a, b) => b.costUsd - a.costUsd || b.input + b.output - (a.input + a.output) || a.model.localeCompare(b.model),
	);
	return summary;
}

function number(value: number): string {
	return value.toLocaleString("en-US");
}

function dollars(value: number): string {
	if (value >= 1) return `$${value.toFixed(2)}`;
	return `$${value.toFixed(4)}`;
}

function pad(value: string, width: number): string {
	return value.length >= width ? value : value.padEnd(width);
}

function monthLabel(since: number): string {
	if (since === 0) return "all time";
	const date = new Date(since);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export type PlanName = "pro" | "trial" | "student" | "business" | "free";

export function normalizePlan(value: string | null | undefined): PlanName | null {
	const plan = value?.trim().toLowerCase() ?? "";
	if (plan.length === 0) return null;
	if (plan.includes("student")) return "student";
	if (plan.includes("business")) return "business";
	if (plan.includes("trial")) return "trial";
	if (plan.includes("pro")) return "pro";
	if (plan.includes("free")) return "free";
	return null;
}

/**
 * Plan name for the credit line. The dashboard's `plan` wins; without a
 * dashboard cookie the user can set ZED_PLAN or put `student` in the `plan`
 * file beside the account store.
 */
export function loadPlan(storePath: string): PlanName | null {
	const fromEnv = normalizePlan(process.env.ZED_PLAN);
	if (fromEnv !== null) return fromEnv;
	const path = join(dirname(storePath), "plan");
	if (!existsSync(path)) return null;
	try {
		return normalizePlan(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

export interface UsageReportOptions {
	plan?: PlanName | null;
	dashboard?: DashboardUsage | null;
	dashboardError?: string | null;
	dashboardUrl?: string | null;
}

/** Human-readable report for `/zed usage`. */
export function formatUsageReport(summary: UsageSummary, options: UsageReportOptions = {}): string {
	const lines = [`Zed usage — ${monthLabel(summary.since)} (turns through this plugin)`];
	if (summary.turns === 0) {
		lines.push("No turns recorded in this window.");
	} else {
		const modelWidth = Math.max(5, ...summary.byModel.map((row) => row.model.length));
		lines.push(
			`${pad("Model", modelWidth)}  ${pad("Turns", 5)}  ${pad("Input", 9)}  ${pad("Output", 9)}  ${pad("Cache R / W", 17)}  Cost`,
		);
		for (const row of summary.byModel) {
			const cache = `${number(row.cacheRead)} / ${number(row.cacheWrite)}`;
			const cost = row.unknownCostTurns > 0 ? `${dollars(row.costUsd)} + n/a` : dollars(row.costUsd);
			lines.push(
				`${pad(row.model, modelWidth)}  ${pad(String(row.turns), 5)}  ${pad(number(row.input), 9)}  ${pad(number(row.output), 9)}  ${pad(cache, 17)}  ${cost}`,
			);
		}
		lines.push(
			`Total: ${summary.turns} turn(s) — ${number(summary.input)} input, ${number(summary.output)} output, ${number(summary.cacheRead)} cache read, ${number(summary.cacheWrite)} cache write.`,
		);
		lines.push(
			`Estimated local cost: ${dollars(summary.costUsd)}${summary.unknownCostTurns > 0 ? ` (${summary.unknownCostTurns} turn(s) had no published rate and are excluded)` : ""}.`,
		);
	}
	switch (options.plan) {
		case "student":
			lines.push("Zed Student includes $10.00/month of token credit; usage beyond it bills at list price +10%.");
			break;
		case "pro":
		case "trial":
			lines.push("Zed Pro includes $5.00/month of token credit; usage beyond it bills at list price +10%.");
			break;
		case "business":
			lines.push("Zed Business has no bundled token credit; usage bills at list price +10%.");
			break;
		case "free":
			lines.push("Zed Free has no hosted-model token credit.");
			break;
		default:
			lines.push(
				"Token credit: Pro $5.00/month, Student $10.00/month; set ZED_PLAN or the dashboard cookie for the exact plan.",
			);
	}

	if (options.dashboard) {
		const spend = options.dashboard.currentUsage;
		if (spend === null) {
			lines.push(`Dashboard: plan ${options.dashboard.plan} — no metered usage on this account.`);
		} else {
			const limit = spend.tokenSpend.limitInCents === null ? "no limit" : `$${(spend.tokenSpend.limitInCents / 100).toFixed(2)} limit`;
			const updated = spend.tokenSpend.updatedAt ? `, updated ${spend.tokenSpend.updatedAt}` : "";
			lines.push(
				`Dashboard: plan ${options.dashboard.plan} — $${(spend.tokenSpend.spendInCents / 100).toFixed(2)} token spend, ${limit}${updated}.`,
			);
			const predictions = spend.editPredictions;
			if (predictions) {
				const cap = predictions.limit === null ? "unlimited" : number(predictions.limit);
				const remaining =
					predictions.remaining === null
						? predictions.limit === null
							? "unlimited"
							: "unknown"
						: number(predictions.remaining);
				lines.push(`Edit predictions: ${number(predictions.used)} used of ${cap} (${remaining} remaining).`);
			}
		}
		if (options.dashboardUrl) lines.push(`  ${options.dashboardUrl}`);
	} else if (options.dashboardError) {
		lines.push(`Dashboard: ${options.dashboardError}`);
	} else {
		lines.push(
			"Dashboard: set ZED_DASHBOARD_COOKIE to the Cookie header from dashboard.zed.dev for exact plan usage.",
		);
	}
	return lines.join("\n");
}
